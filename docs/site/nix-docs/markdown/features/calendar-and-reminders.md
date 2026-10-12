# Calendar and reminders

## Calendars

A calendar view places a container's children on the day or hour that a date field names. Give it a second date field and items become spans with an end. You can:

- switch between day, week and month;
- drag an item to another day, or onto the hour it belongs at;
- drag and resize timed entries in 15-minute steps;
- drop an unscheduled item onto the calendar to schedule it;
- create an entry by clicking an empty slot.

The **Calendar** destination on the rail collates every calendar in the workspace into one, and can be filtered by container.

Calendars are drawn in your own clock. Date-and-time fields keep the time zone they were written in.

## Recurrence

Tasks and calendar entries can repeat. Nix calculates occurrences when they are read rather than creating a copy for each one, so a weekly meeting does not fill the tree. You can complete a single occurrence of a repeating task.

## Two-way calendar sync

Connect Google Calendar or Microsoft Outlook from the **Calendars** tab in settings, then link a provider calendar to a container in Nix.

- Events from the provider appear as ordinary items in that container and in your calendar views.
- Dated Nix items you add to the container are pushed out to the provider.
- Edits on either side sync both ways. When both change, the most recent write wins, and every sync is recorded in a log you can read.
- Linked containers and their events are protected: they are removed by unlinking, not by deleting them in the tree. When you unlink, you choose whether to keep the items or move them to the trash. Nothing is deleted from the provider either way.
- Events the provider marks read-only keep their title and times; you can still add your own properties and notes to them.

Sync runs on a schedule. Calendar sync needs the operator of your Nix instance to register an OAuth application with Google or Microsoft (see [Configuration](nix://item/01a130b0-14df-721e-b23c-3f24282e0eae)).

## Reminders and notifications

There are three kinds of reminder:

- **Explicit reminders:** set a Reminder field on any item to a date and time.
- **Due reminders:** Nix reminds you about tasks on their due date at a time you choose.
- **Habit reminders:** each habit can have its own reminder time.

Reminders arrive in the notification inbox and, if you allow it, as push notifications through the installed app. Notification preferences include your time zone, quiet hours, the due-reminder time, switches for due and habit reminders, and muting particular containers.

From the command line:

```sh
nixctl remind set <item-id> +90m
nixctl notifications prefs set --quiet 22:00-07:00 --time-zone Europe/London
```

## Automations

Automations are rules you write for yourself. Other members never see them.

**Triggers**

- a schedule: daily, weekly or monthly at a time;
- a date arriving: when a date field on an item comes round, with an optional offset;
- a property changing: optionally from one value or to another.

**Conditions** test the triggering item's fields (equals, does not equal, is empty, is set). A rule can have up to five.

**Actions** run in order:

- notify you, with a title and body;
- set properties on the triggering item or another item;
- create a new item, under the triggering item, the rule's scope or a chosen container.

Titles can include `{date}` and `{item.title}`. Every run is logged with its outcome. A dry run shows what a rule would do without writing anything. A rule that fails five times in a row is disabled automatically until you turn it back on.

