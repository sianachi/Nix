# What Sites can grow into

Everything on this page is an idea. None of it is built. Each idea is listed with where it would fit in the current design, because the design is what makes some of these cheap and others hard.

The constraints any of them must keep: a reader's request never reaches Core or the database, the serving process stays anonymous and read-only, and nothing becomes public without a manager publishing it.

## Publishing targets

**Push to Cloudflare Pages or another static host.** *Not built.* A build is already a complete directory of static files with a manifest that lists every one of them. A second activation step could upload the sealed build to an external host instead of, or as well as, writing host manifests, so a site could stay up while the Nix server is offline.

**Scheduled publishing.** *Not built.* Dated collections already hold back posts until their date. A scheduled publish would add a time to a site's republish settings, using the same scheduler that drives reminders, so a post goes live on its date without anyone pressing Publish.

## Look and feel

**User themes and custom CSS.** *Not built.* Today every site uses the built-in theme with an accent colour. Custom CSS could be published as one more file in the build. It would have to stay within the Content Security Policy, which allows styles only from the site itself, and could not add scripts.

**Per-page social images.** *Not built.* Pages already carry Open Graph metadata and use a post's cover when it has one. The build worker could draw a card image for every other page from its title and the site's accent colour.

**Multi-language sites.** *Not built.* A site has one language setting today. Language variants would need a property linking a page to its translations, alternate-language links in each page's head, and a language switch in the theme.

## Readers

**Privacy-respecting analytics.** *Not built.* Sites set no cookies and load nothing from third parties, and that should not change. Counting would have to happen at the serving process, as aggregate page counts without identifiers, rather than through a script in the reader's browser.

**Comments.** *Not built.* Comments in the workspace are never published. Public comments would be the first feature that accepts writes from anonymous readers, so they would need their own service, moderation in the workspace before anything appears, and spam protection, all outside the read-only serving process.

**Password-protected sites.** *Not built.* Item locks already keep locked pages out of every build. A protected site would be a different thing: a whole site visible only to people with a shared password or a signed link, checked by the serving process before it returns a file.

**Ask this site.** *Not built.* An assistant that answers questions from a site's published pages only. The build already produces a search index of exactly what was published, which is the right boundary: it would never see anything withheld from the site.

## Content

**Live views.** *Not built.* Views are rendered into each page at build time, so a task list on a site is as fresh as its last build. A live view would need a narrow public endpoint for one published view, which is a deliberate break from the rule that readers never reach Core, and would need its own design review.

**Sheets and canvases.** *Not built.* Sheet and canvas bodies are currently listed in the build report as not published. They could be rendered as static tables and SVG drawings, in the same way boards and charts already are.

**Git sync with a text format.** *Not built, and deferred.* A site's pages could be mirrored to a Git repository as text files, and changes pulled back. This needs a stable, lossless text format for item bodies and properties first. Nix's `.nix` export is lossless but not meant to be edited by hand, and Markdown export reports what it loses.

