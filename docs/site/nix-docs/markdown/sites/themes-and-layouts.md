# Themes and layouts

Every site uses the built-in Nix theme. You choose one of two layouts and an accent colour; the theme does the rest. Pages are plain HTML and CSS, readable without JavaScript, and set in Nunito Sans served from the site itself.

## Shared by both layouts

- **A header** with the site name, your top navigation links and a light and dark switch. The switch follows the reader's system setting until they choose, and remembers the choice in the browser. It appears only once the theme script has loaded.
- **A footer** with your footer text, links to the site's feeds, and a "Built with Nix" link unless you turn it off.
- **A facts block** under each page title. A page's properties are shown as a short list of labelled values, using the labels and types from the schema that applies to the page. Some things are never shown: the title, system properties, people, reminders, formulas and rollups, images, the date, tags, cover and summary a dated collection already uses, and empty values. A `subtitle` property is shown as the page's lead paragraph instead.
- **Dated collections:** an index grouped by year, a page for each tag, and an Atom feed.
- **Code blocks** with syntax highlighting.
- **A 404 page**, canonical links and social preview metadata.

## Docs

For documentation, handbooks and knowledge bases.

- The home page opens with the site name, the description and a map of the whole site, followed by the root page's own content.
- Every page has a sidebar with the full page tree. On a phone, the tree folds into a "Browse" menu at the top of the page.
- Breadcrumbs above the title, and an "On this page" table of contents from the page's headings, each of which has an anchor link.
- A page with children ends with "In this section" cards for them.
- Previous and next links follow the order of the tree.
- A search box in the header searches every published page, entirely in the reader's browser, from an index built with the site. Press `/` to focus it.

## Blog

For a personal site, a portfolio or a blog.

- The home page introduces the site, then gives each top-level page that has children a section of its own: the latest five entries of a dated collection, or cards for the page's children.
- Posts show their date, an estimated reading time, tags and cover image, with older and newer links.
- Everything else is a plain page.
- The blog layout has no search box.

## Accent colour and settings

The accent colour, given as `#rrggbb`, is used for links and highlights in both light and dark mode. The site name, description, navigation, footer text and language are all site settings; see [Managing a site](nix://item/01a13137-b778-7f7e-9a3a-bd1413c167bf). Custom themes and custom CSS are not supported.

