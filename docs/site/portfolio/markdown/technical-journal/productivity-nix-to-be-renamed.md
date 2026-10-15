# Productivity: Nix (To be renamed)

I enjoy learning and building things, so naturally I got productivity-pilled: Notion, Obsidian, E-Ink tablets. Along the way I fell for heavy metal, game modding and Olympic weightlifting. (Not much carry-over, I know.) But it sparked something. I needed a way to organise my life.

Every tool taught me something. Todoist taught me to run my hobbies as projects. Obsidian’s graph view taught me to think differently about notes and to journal with intent. Notion taught me that information shouldn’t be text alone.

A few months later I needed pro features from five different tools, and I didn’t want to pay £100 a month just to be productive. So I built something that did everything I needed.

### Everything is an item

In Nix, a note, a project, a reading list and a budget are all the same thing: an item with an optional body, properties and children. What changes is how you look at the children. The same tasks can be a list on Monday, a board on Tuesday and a calendar on Friday, with no copying. 

A body doesn’t have to be text, either. It can be a canvas for diagrams, or a spreadsheet with real A1 formulas. Notes support Mermaid diagrams, tables, callouts and columns.

### Projects, links and journaling

From Todoist: tasks with due dates, priorities and recurrence, Today and Overdue views, push reminders with quiet hours, automations, and two-way sync with Google Calendar and Outlook.

From Obsidian: `[[` links, backlinks, a graph view with a time view, and daily notes that file themselves. There’s a Vim mode, and an Emacs mode, because I’m not a monster.

I also built habit tracking with streaks, and finance tracking with budgets, bank CSV imports and a close-the-month checklist, which is the most adult thing I have ever built.

### AI that lives in my notes

This changed how I use Nix the most. I use AI to manage my notes, summarise my journals and pull insights from my weeks, months and year. Months of daily notes become something I can ask questions of.

I self-host a lot of things, and my journal is the last thing I’d hand to another subscription app. So the AI lives inside Nix, on my server. You bring your own provider: Claude with an Anthropic API key, OpenRouter (including open-weight models), or, for now, a ChatGPT subscription.

The AI is a companion pet that can search, write, reorganise and build structure. Ask for a training log and you get the container, fields and views, and the pets are genuinely good at picking the right view. They also have no special access: every action goes through my permissions, and every plan is shown to me before it runs. Through MCP, any other AI tool can work with my notes under the same rules.

My favourite habit is asking the companion for feedback on its own tool usage: what was awkward and what it would change. An AI using your product all day is a very honest user. \[Example: the companion pointed out that it struggled to produce the correct json format for the nix format and was just guessing\]

### Built for teams, and for building itself

A collaboration server gives Nix real-time editing with live cursors, plus roles and invitations, all enforced by the database rather than the browser. That makes it a solid home for a small team.

It’s also where I build Nix. My dev notes, plans, decisions and Mermaid architecture diagrams all live in Nix, and through `nixctl` and MCP, my coding agents read the same docs I do. If something annoys me, it gets fixed, because I’ll hit it again tomorrow.

### This blog is a note

You’re reading Nix right now. Any page tree can be published as a static site. My blog, portfolio and the Nix docs are all just notes.

Even the website for the product is written in Nix: [https://nix.nixsites.com/](https://nix.nixsites.com/)

### What’s next

Nix is v0.1, and I want it to be a premium product. Friction irritates me, and in beta I’m the one feeling it most.

First, a cleaner desktop UI. Second, a native mobile app. The PWA’s offline support is my biggest pain point: it only keeps notes I’ve already opened, and the browser decides how long to keep them. I want my whole life available on a train with no signal. I’m deciding between React Native and fully native, with Swift first and Kotlin later.

Android matters for one more reason: my E-Ink tablet runs it. Journaling on E-Ink, synced to my own server, is the setup I wanted when I first got productivity-pilled.

### The catch

Nix is self-hosted and isn’t small yet, and it needs a new name, because Nix is taken by a famous package manager. Suggestions welcome.

It's still rough around the edges and still needs a couple of months before it's the premium product that I'm currently dreaming of but this is a great start and it's already very useful to me.

