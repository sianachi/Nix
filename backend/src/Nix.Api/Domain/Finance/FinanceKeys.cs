namespace Nix.Domain.Finance;

/// <summary>
/// The property keys the finance module owns on ordinary items.
/// </summary>
/// <remarks>
/// <para>
/// <b>Reserved by prefix.</b> Finance endpoints validate writes; generic item commands and import
/// paths reject the prefix so they cannot bypass the finance model. The module reads stored values
/// defensively and reports malformed records rather than hiding them.
/// </para>
/// <para>
/// The root carries the settings and the identifiers of its three containers. Each record in a
/// container says what it is with <see cref="Kind"/>, so a stray child of the wrong kind is
/// skipped rather than misread.
/// </para>
/// </remarks>
public static class FinanceKeys
{
    public const string Prefix = "$fin_";

    // Root settings.
    public const string Currency = "$fin_currency";
    public const string StartMonth = "$fin_start_month";
    public const string HorizonMonths = "$fin_horizon_months";
    public const string OpeningCash = "$fin_opening_cash";
    public const string EmergencyFundMonths = "$fin_emergency_months";
    public const string Timezone = "$fin_timezone";
    public const string AccountsContainer = "$fin_accounts_id";
    public const string LinesContainer = "$fin_lines_id";
    public const string TransactionsContainer = "$fin_transactions_id";
    public const string ClosedMonths = "$fin_closed_months";

    // Every record.
    public const string Kind = "$fin_kind";
    public const string Archived = "$fin_archived";

    // Accounts.
    public const string AccountType = "$fin_account_type";
    public const string Limit = "$fin_limit";
    public const string OpeningBalance = "$fin_opening_balance";
    public const string SettlesFrom = "$fin_settles_from";
    public const string Apr = "$fin_apr";
    public const string Payment = "$fin_payment";
    public const string Overpayment = "$fin_overpayment";
    public const string Target = "$fin_target";

    // Budget lines.
    public const string Section = "$fin_section";
    public const string Flow = "$fin_flow";
    public const string Account = "$fin_account";
    public const string Amount = "$fin_amount";
    public const string Overrides = "$fin_overrides";
    public const string Scheduled = "$fin_scheduled";
    public const string DueDay = "$fin_due_day";
    public const string LoanAccount = "$fin_loan_account";

    // Transactions.
    public const string Date = "$fin_date";
    public const string Line = "$fin_line";
    public const string Source = "$fin_source";
    public const string PostedFor = "$fin_posted_for";
    public const string ImportKey = "$fin_import_key";
    public const string Cleared = "$fin_cleared";
}

/// <summary>The values <see cref="FinanceKeys.Kind"/> may take.</summary>
public static class FinanceKinds
{
    public const string Account = "account";
    public const string Line = "line";
    public const string Transaction = "transaction";
}

/// <summary>The values <see cref="FinanceKeys.AccountType"/> may take.</summary>
public static class FinanceAccountTypes
{
    public const string Current = "current";
    public const string Savings = "savings";
    public const string Debit = "debit";
    public const string CreditCard = "credit_card";
    public const string Loan = "loan";

    public static bool IsValid(string? value) => value is Current or Savings or Debit or CreditCard or Loan;
}

/// <summary>The values <see cref="FinanceKeys.Flow"/> may take.</summary>
public static class FinanceFlows
{
    public const string Income = "income";
    public const string Expense = "expense";

    public static bool IsValid(string? value) => value is Income or Expense;
}

/// <summary>The values <see cref="FinanceKeys.Source"/> may take.</summary>
public static class FinanceSources
{
    public const string Manual = "manual";
    public const string Scheduled = "scheduled";
    public const string Import = "import";

    public static bool IsValid(string? value) => value is Manual or Scheduled or Import;
}
