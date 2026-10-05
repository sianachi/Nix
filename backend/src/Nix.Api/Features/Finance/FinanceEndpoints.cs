using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Domain.Finance;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Finance;

/// <summary>
/// One group under a finance root. Records are ordinary items, so deleting any of them is the
/// ordinary item delete; everything here validates a <c>$fin_</c> write or computes a figure.
/// </summary>
internal static class FinanceEndpoints
{
    private const int MaximumImportBodyBytes = CsvStatements.MaximumBytes + 4096;

    internal static IEndpointRouteBuilder MapFinanceEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/items/{itemId:guid}/finance").WithTags("Finance");

        group.MapGet("", Read)
            .WithName("GetFinance")
            .WithSummary("Read a finance root's settings, accounts, budget lines and closed months")
            .Produces<FinanceResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422);
        group.MapPut("", Set)
            .WithName("SetFinanceSettings")
            .WithSummary("Make an item a finance root, or change its settings")
            .WithDescription("The first call creates three child containers, Accounts, Budget lines and Transactions, and records their identifiers on the root. Later calls change the settings only.")
            .Produces<FinanceResponse>().ProducesProblem(404).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        group.MapGet("/accounts", Accounts)
            .WithName("GetFinanceAccounts")
            .WithSummary("Every account with the figure that matters for it in a month")
            .Produces<FinanceAccountsResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422);
        group.MapPost("/accounts", CreateAccount)
            .WithName("CreateFinanceAccount")
            .Produces<FinanceAccountResponse>(201).ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPut("/accounts/{accountId:guid}", SetAccount)
            .WithName("SetFinanceAccount")
            .Produces<FinanceAccountResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapGet("/accounts/{accountId:guid}/loan", Loan)
            .WithName("GetFinanceLoan")
            .WithSummary("A loan's repayment schedule, and what a different overpayment would buy")
            .Produces<LoanScheduleResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422);

        group.MapPost("/lines", CreateLine)
            .WithName("CreateBudgetLine")
            .Produces<BudgetLineResponse>(201).ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPut("/lines/{lineId:guid}", SetLine)
            .WithName("SetBudgetLine")
            .Produces<BudgetLineResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPost("/lines/{lineId:guid}/months/{month}/actual", SetActual)
            .WithName("SetBudgetActual")
            .WithSummary("Bring a line's actual for a month to an amount by recording the transaction that gets it there")
            .WithDescription("With nothing recorded yet, the whole amount is recorded as one transaction named after the line; otherwise an adjustment for the difference is recorded. Actual is never overwritten, only added to.")
            .Produces<BudgetActualResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        group.MapGet("/transactions", Transactions)
            .WithName("ListFinanceTransactions")
            .WithSummary("Transactions newest first, narrowed by month, account or line")
            .Produces<FinanceTransactionsResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422);
        group.MapPost("/transactions", CreateTransaction)
            .WithName("CreateFinanceTransaction")
            .WithSummary("Record a transaction; the amount is its cash effect, negative when money left")
            .Produces<FinanceTransactionResponse>(201).ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPut("/transactions/{transactionId:guid}", SetTransaction)
            .WithName("SetFinanceTransaction")
            .Produces<FinanceTransactionResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapDelete("/transactions/{transactionId:guid}", DeleteTransaction)
            .WithName("DeleteFinanceTransaction")
            .WithSummary("Delete a transaction in an open month; the ordinary item delete, so it can be restored")
            .WithDescription("Unlike the item delete, a repeat is refused with finance.transaction_not_found, because the ledger no longer holds the transaction.")
            .Produces(204).ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        group.MapGet("/budget", Budget)
            .WithName("GetFinanceBudget")
            .WithSummary("Lines by month with plan, actual and variance; defaults to the current month, narrowed to one account when asked")
            .Produces<BudgetGridResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422);
        group.MapGet("/cashflow", CashFlow)
            .WithName("GetFinanceCashFlow")
            .WithSummary("Cash month by month across the horizon, actual for closed months and plan for open ones")
            .Produces<CashFlowResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422);
        group.MapGet("/dashboard", Dashboard)
            .WithName("GetFinanceDashboard")
            .WithSummary("The month's position, the cards, the loans, what needs watching and what is due soon")
            .Produces<FinanceDashboardResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422);

        group.MapGet("/months/{month}", Month)
            .WithName("GetFinanceMonth")
            .WithSummary("What closing a month would leave unresolved")
            .Produces<MonthChecklistResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422);
        group.MapPut("/months/{month}", SetMonth)
            .WithName("SetFinanceMonth")
            .WithSummary("Close or reopen a month")
            .Produces<FinanceMonthResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        group.MapPost("/months/{month}/post-scheduled", PostScheduled)
            .WithName("PostFinanceScheduled")
            .WithSummary("Post every scheduled line's planned amount for the month, once")
            .Produces<PostScheduledResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        group.MapPost("/import", Import)
            .WithName("ImportFinanceStatement")
            .WithSummary("Read a bank CSV into an account, previewing unless commit is true")
            .WithRequestBodyLimit(MaximumImportBodyBytes)
            .Produces<FinanceImportResponse>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(413).ProducesProblem(422)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        return endpoints;
    }

    private static async Task<Results<Ok<FinanceResponse>, ProblemHttpResult>> Read(Guid itemId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<ReadFinance, Result<FinanceResponse>>(new ReadFinance(ItemId.From(itemId)), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<FinanceResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<FinanceResponse>, ProblemHttpResult>> Set(Guid itemId, FinanceSettingsRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<SetFinanceSettings, FinanceResponse>(new SetFinanceSettings(ItemId.From(itemId), request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<FinanceResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<FinanceAccountsResponse>, ProblemHttpResult>> Accounts(Guid itemId, [FromQuery] string? month, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        if (!TryMonth(month, out var parsed))
        {
            return Problem(context, InvalidMonth());
        }
        var result = await dispatcher.QueryAsync<ReadFinanceAccounts, Result<FinanceAccountsResponse>>(new ReadFinanceAccounts(ItemId.From(itemId), parsed), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<FinanceAccountsResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Created<FinanceAccountResponse>, ProblemHttpResult>> CreateAccount(Guid itemId, FinanceAccountRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<CreateFinanceAccount, FinanceAccountResponse>(new CreateFinanceAccount(ItemId.From(itemId), request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Created<FinanceAccountResponse>, ProblemHttpResult>>(
            value => TypedResults.Created($"/api/v1/items/{value.Id:D}", value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<FinanceAccountResponse>, ProblemHttpResult>> SetAccount(Guid itemId, Guid accountId, FinanceAccountRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<SetFinanceAccount, FinanceAccountResponse>(new SetFinanceAccount(ItemId.From(itemId), accountId, request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<FinanceAccountResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<LoanScheduleResponse>, ProblemHttpResult>> Loan(Guid itemId, Guid accountId, [FromQuery] decimal? overpayment, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<ReadLoanSchedule, Result<LoanScheduleResponse>>(new ReadLoanSchedule(ItemId.From(itemId), accountId, overpayment), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<LoanScheduleResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Created<BudgetLineResponse>, ProblemHttpResult>> CreateLine(Guid itemId, BudgetLineRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<CreateBudgetLine, BudgetLineResponse>(new CreateBudgetLine(ItemId.From(itemId), request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Created<BudgetLineResponse>, ProblemHttpResult>>(
            value => TypedResults.Created($"/api/v1/items/{value.Id:D}", value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<BudgetLineResponse>, ProblemHttpResult>> SetLine(Guid itemId, Guid lineId, BudgetLineRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<SetBudgetLine, BudgetLineResponse>(new SetBudgetLine(ItemId.From(itemId), lineId, request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<BudgetLineResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<BudgetActualResponse>, ProblemHttpResult>> SetActual(Guid itemId, Guid lineId, string month, BudgetActualRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        if (!YearMonth.TryParse(month, out var parsed))
        {
            return Problem(context, InvalidMonth());
        }
        var result = await dispatcher.SendAsync<SetBudgetActual, BudgetActualResponse>(new SetBudgetActual(ItemId.From(itemId), lineId, parsed, request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<BudgetActualResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> DeleteTransaction(Guid itemId, Guid transactionId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<DeleteFinanceTransaction, Guid>(new DeleteFinanceTransaction(ItemId.From(itemId), transactionId), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<NoContent, ProblemHttpResult>>(_ => TypedResults.NoContent(), error => Problem(context, error));
    }

    private static async Task<Results<Ok<FinanceTransactionsResponse>, ProblemHttpResult>> Transactions(
        Guid itemId, [FromQuery] string? month, [FromQuery] Guid? accountId, [FromQuery] Guid? lineId, [FromQuery] bool? unassigned, [FromQuery] int? limit, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        if (!TryMonth(month, out var parsed))
        {
            return Problem(context, InvalidMonth());
        }
        var result = await dispatcher.QueryAsync<ListFinanceTransactions, Result<FinanceTransactionsResponse>>(
            new ListFinanceTransactions(ItemId.From(itemId), parsed, accountId, lineId, unassigned ?? false, limit ?? 0), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<FinanceTransactionsResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Created<FinanceTransactionResponse>, ProblemHttpResult>> CreateTransaction(Guid itemId, FinanceTransactionRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<CreateFinanceTransaction, FinanceTransactionResponse>(new CreateFinanceTransaction(ItemId.From(itemId), request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Created<FinanceTransactionResponse>, ProblemHttpResult>>(
            value => TypedResults.Created($"/api/v1/items/{value.Id:D}", value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<FinanceTransactionResponse>, ProblemHttpResult>> SetTransaction(Guid itemId, Guid transactionId, FinanceTransactionRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<SetFinanceTransaction, FinanceTransactionResponse>(new SetFinanceTransaction(ItemId.From(itemId), transactionId, request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<FinanceTransactionResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<BudgetGridResponse>, ProblemHttpResult>> Budget(Guid itemId, [FromQuery] string? from, [FromQuery] string? to, [FromQuery] Guid? accountId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        if (!TryMonth(from, out var start) || !TryMonth(to, out var end))
        {
            return Problem(context, InvalidMonth());
        }
        var result = await dispatcher.QueryAsync<ReadBudgetGrid, Result<BudgetGridResponse>>(new ReadBudgetGrid(ItemId.From(itemId), start, end, accountId), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<BudgetGridResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<CashFlowResponse>, ProblemHttpResult>> CashFlow(Guid itemId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.QueryAsync<ReadCashFlow, Result<CashFlowResponse>>(new ReadCashFlow(ItemId.From(itemId)), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<CashFlowResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<FinanceDashboardResponse>, ProblemHttpResult>> Dashboard(Guid itemId, [FromQuery] string? month, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        if (!TryMonth(month, out var parsed))
        {
            return Problem(context, InvalidMonth());
        }
        var result = await dispatcher.QueryAsync<ReadFinanceDashboard, Result<FinanceDashboardResponse>>(new ReadFinanceDashboard(ItemId.From(itemId), parsed), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<FinanceDashboardResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<MonthChecklistResponse>, ProblemHttpResult>> Month(Guid itemId, string month, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        if (!YearMonth.TryParse(month, out var parsed))
        {
            return Problem(context, InvalidMonth());
        }
        var result = await dispatcher.QueryAsync<ReadFinanceMonth, Result<MonthChecklistResponse>>(new ReadFinanceMonth(ItemId.From(itemId), parsed), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<MonthChecklistResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<FinanceMonthResponse>, ProblemHttpResult>> SetMonth(Guid itemId, string month, FinanceMonthRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        if (!YearMonth.TryParse(month, out var parsed))
        {
            return Problem(context, InvalidMonth());
        }
        var result = await dispatcher.SendAsync<SetFinanceMonth, FinanceMonthResponse>(new SetFinanceMonth(ItemId.From(itemId), parsed, request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<FinanceMonthResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<PostScheduledResponse>, ProblemHttpResult>> PostScheduled(Guid itemId, string month, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        if (!YearMonth.TryParse(month, out var parsed))
        {
            return Problem(context, InvalidMonth());
        }
        var result = await dispatcher.SendAsync<PostScheduledTransactions, PostScheduledResponse>(new PostScheduledTransactions(ItemId.From(itemId), parsed), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<PostScheduledResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static async Task<Results<Ok<FinanceImportResponse>, ProblemHttpResult>> Import(Guid itemId, FinanceImportRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<ImportFinanceStatement, FinanceImportResponse>(new ImportFinanceStatement(ItemId.From(itemId), request), context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<FinanceImportResponse>, ProblemHttpResult>>(value => TypedResults.Ok(value), error => Problem(context, error));
    }

    private static bool TryMonth(string? text, out YearMonth? month)
    {
        month = null;
        if (string.IsNullOrEmpty(text))
        {
            return true;
        }
        if (!YearMonth.TryParse(text, out var parsed))
        {
            return false;
        }
        month = parsed;
        return true;
    }

    private static NixError InvalidMonth() => new("finance.invalid_month", "Months are written yyyy-MM.");

    private static ProblemHttpResult Problem(HttpContext context, NixError error)
    {
        var status = error.Code.EndsWith("not_found", StringComparison.Ordinal) ? 404
            : error.Code is "items.locked" ? 423
            : error.Code is "finance.not_configured" or "finance.month_closed" or "finance.limit" or "items.lifecycle_conflict" ? 409
            : 422;
        return TypedResults.Problem(ApiProblem.Create(context, status, error.Code, "Finance request refused", error.Message));
    }
}
