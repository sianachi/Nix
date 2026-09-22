using System.Text.Json.Serialization;
using Nix.Features.Finance;

namespace Nix.Serialization;

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(DateOnly?))]
[JsonSerializable(typeof(decimal?))]
[JsonSerializable(typeof(FinanceSettingsRequest))]
[JsonSerializable(typeof(FinanceResponse))]
[JsonSerializable(typeof(FinanceAccountRequest))]
[JsonSerializable(typeof(FinanceAccountResponse))]
[JsonSerializable(typeof(FinanceAccountsResponse))]
[JsonSerializable(typeof(BudgetLineRequest))]
[JsonSerializable(typeof(BudgetLineResponse))]
[JsonSerializable(typeof(FinanceTransactionRequest))]
[JsonSerializable(typeof(FinanceTransactionResponse))]
[JsonSerializable(typeof(FinanceTransactionsResponse))]
[JsonSerializable(typeof(BudgetGridResponse))]
[JsonSerializable(typeof(LoanScheduleResponse))]
[JsonSerializable(typeof(CashFlowResponse))]
[JsonSerializable(typeof(FinanceDashboardResponse))]
[JsonSerializable(typeof(FinanceMonthRequest))]
[JsonSerializable(typeof(FinanceMonthResponse))]
[JsonSerializable(typeof(MonthChecklistResponse))]
[JsonSerializable(typeof(PostScheduledResponse))]
[JsonSerializable(typeof(FinanceImportRequest))]
[JsonSerializable(typeof(FinanceImportResponse))]
internal sealed partial class FinanceJsonContext : JsonSerializerContext;
