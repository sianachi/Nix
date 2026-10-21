# Tasks, habits and finance

Tasks, habits and money in Nix are ordinary items with fields that carry a meaning. There is no separate task app or budgeting module: a task list is a container whose children have a due date and a completion field.

## Tasks

Declare task fields on a container (due date, start date, completion, priority, estimate and assignee) and the items inside become tasks. Because the field type carries the meaning, smart lists and timelines know which field is the due date without you naming it.

Built-in smart lists cover the usual questions:

- **Today**
- **Next 7 days**
- **Overdue**
- **Assigned to me**

Tasks can repeat. Nix works out each occurrence when you look at a calendar or list, so a daily task does not fill your workspace with copies. You can complete a single occurrence and select several tasks to assign them at once.

## Habits

A habit tracker view shows each habit with a check-in button, its current status and a streak. Check-ins can be undone. Insights include charts and a year grid of the days you kept the habit. Each habit can have its own reminder time.

## Finance

The finance view turns a container into a personal finance workbook:

- accounts and loans;
- budget lines with actuals, narrowed by account and edited in place;
- transactions and scheduled postings;
- cash flow and a dashboard;
- a close-month checklist;
- bank CSV import with a preview before anything is committed.

Finance data lives in ordinary items, so it exports, searches and backs up like everything else. `nixctl finance` and the MCP finance tools give you the same data from scripts.

## Properties

- title: Tasks, habits and finance

