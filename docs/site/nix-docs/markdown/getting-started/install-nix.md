# Install Nix

There are two ways to run Nix: a local development stack for trying it out, and a production deployment with Docker Compose.

## Try it locally

The local stack runs every service on your own machine, including a development identity provider and mail catcher. You need Docker and [mise](https://mise.jdx.dev), which installs the pinned toolchain.

```sh
git clone https://github.com/sianachi/Nix.git
cd Nix
mise install
pnpm install --frozen-lockfile
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173) and sign in. `pnpm dev` provisions the development infrastructure, builds the shared packages and starts the API, the collaboration service, the background workers and the web app. Run `bash scripts/dev.sh --help` to start only some of them.

The local stack is for evaluation and development. Do not expose it to the internet.

## Run it for real

For a deployment you intend to keep, use the images that CI publishes to the GitHub Container Registry, with either the Docker Compose manifest or the Kubernetes manifests. The [Deployment](nix://item/01a130b0-077c-7b80-9e9e-eb091bb7a0ce) section covers both paths, requirements, configuration, backups and upgrades.

## Install the app on your devices

Nix is a progressive web app. Once your instance is running behind HTTPS, open it in a supported browser and use the browser's install option ("Install app" or "Add to Home Screen").

The installed app gives you:

- launch shortcuts for **New note**, **Today** and **Search**;
- a share target, so you can share text or a link from another app into Nix;
- a Markdown file handler, so `.md` files can open in Nix;
- offline access to your downloaded notes (see [Collaboration and offline](nix://item/01a130b0-0b97-7da4-aaf4-8ece03849441));
- push notifications for reminders, once you allow them.

Updates arrive as an "An update is ready" prompt. Nix finishes saving pending work before it reloads into the new version.

