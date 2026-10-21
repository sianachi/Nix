# Hostnames and DNS

Every site has a default address, and can also answer on hostnames you own. One hostname is the primary: the address that pages give as their canonical link.

## The default hostname

The default hostname is `<slug>.<sites-domain>`, where the sites domain is set by whoever runs the instance. It is verified from the start and needs no DNS work from the site's managers, because the instance's wildcard record already covers it. If an instance has no sites domain configured, Sites is switched off.

### A second instance on the same sites domain

A single wildcard certificate covers one level of names, so two instances cannot both put sites at `*.<sites-domain>` without one taking the other's names. Instead, the second instance can give its default hostnames a label suffix: with a suffix of `-home`, a site with the slug `notes` is served at `notes-home.<sites-domain>`. The suffix is a hyphen followed by up to 20 characters.

On such an instance:

- there is no wildcard record for it; with a Cloudflare token and the zone configured, Nix writes one proxied record per site, and a tunnel route when a tunnel is used;
- its sites server answers only for names that carry its suffix, and refuses the other instance's names;
- the other instance refuses slugs that end in the suffix, so the two can never claim the same name.

## Custom hostnames

A site can have up to 10 hostnames of your own, such as `docs.<your-domain>` or `<your-domain>` itself. A custom hostname cannot be the sites domain, a name under it, or the app's own hostname.

Adding a hostname shows the DNS records to create:

| Type | Name | Value | Purpose |
| --- | --- | --- | --- |
| TXT | \_nix-site.\<hostname> | nix-site-verification=\<token> | Proves you control the name. The token is unique to this claim |
| CNAME | \<hostname> | The routing target the instance publishes | Sends readers to the instance |

The TXT record is what proves ownership. For routing, Nix only checks that the name resolves to an address, because a proxied or flattened name answers with addresses rather than with the CNAME. A hostname at the top of a zone, such as `<your-domain>`, needs a DNS provider that can flatten a CNAME at the apex.

Nix checks a pending hostname every 5 minutes and you can ask for a check at most once a minute. A claim that never verifies is withdrawn after 7 days. Once verified, a hostname is checked every 6 hours, and is taken out of service after three failed checks in a row, so a domain that lapses or moves to someone else stops serving your site. Only verified hostnames are ever served.

## Automatic DNS on Cloudflare

An operator can hand a Cloudflare zone to a workspace. For a hostname in that zone, Nix creates the records itself: the verification TXT record, a proxied CNAME to the instance's tunnel or routing target, and, when a tunnel is used, the tunnel's public hostname rule. Hostnames it manages are marked "Managed by Nix".

The automation is deliberately narrow:

- **It never overwrites or deletes a record it did not create.** If someone else's record already routes the name, the hostname fails with a message saying the record was left alone.
- **All or nothing.** If any step fails, whatever that attempt created is deleted again.
- **One zone, one workspace.** A zone is handed to exactly one workspace, so no other workspace can claim names in it.
- **Never the apex.** The top of a zone is always set up by hand.
- **No overlap.** A managed zone may not overlap the sites domain or the app's own domain.

Removing a hostname deletes exactly the records Nix created for it, and nothing else.

## Primary and alias hostnames

The primary hostname is the canonical address. Until a primary custom hostname is verified and served, the default hostname is canonical. Changing the primary changes the canonical links inside pages at the next publish.

Every other hostname is an alias, and answers in one of two ways:

| Mode | Behaviour |
| --- | --- |
| Serve (serve) | Serves the same build with a 200. Canonical links still point at the primary |
| Redirect (redirect) | Answers with a permanent 308 redirect to the same path and query on the primary |

## How the serving process uses hostnames

Each served hostname has a small host manifest in storage, written when a build goes live, that names the build to serve and whether to redirect. The sites server looks up the request's `Host` in those manifests. A default hostname with no live site gets a plain `404`. A custom hostname without a manifest, which means it has not been verified, the sites domain itself and another instance's names are all refused with `421`, which tells the client this server does not answer for that name. The server only answers `GET` and `HEAD`.

## Properties

- title: Hostnames and DNS

