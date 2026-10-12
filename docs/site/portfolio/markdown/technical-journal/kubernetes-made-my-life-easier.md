# Kubernetes made my life easier

I've started taking my personal projects more seriously, which means I've been doing a lot more deployment than I used to.

For a while, the workflow was simple: write a `docker-compose.yml`, push it to my VPS, deploy through Portainer. Fine on paper. In practice, every deployment was a frenzy. SSL certificates misbehaved. One service would come up while another silently failed. I'd forget which compose flag I needed this time. No matter how often I did it, something was always slightly broken, and the fix was always slightly different from last time.

Eventually I came across k3s: a lightweight Kubernetes distribution that ships as a single binary.

## The detour that pushed me over the edge

I was originally going to deploy my new portfolio to Vercel. Then I hit the limit: 11 serverless functions per project on the free tier. The portfolio itself is simple, but I wanted a blog attached for technical writeups, and that pushed me over. The next tier was £20 a month.

I already pay £10 a month for a VPS that was sitting mostly idle. So I stopped renting someone else's abstraction and ran my own.

## The stack

The portfolio is straightforward, but the blog adds a few moving parts:

- MinIO for S3-compatible object storage (blog images, assets)
- MongoDB for blog content
- Express.js API
- React frontend

Under docker-compose, that's four services wired together imperatively, plus a reverse proxy, plus whatever I cobble together for TLS. Under k3s, it's four manifests. Traefik handles ingress out of the box. cert-manager handles SSL declaratively. I describe what I want; the cluster makes it true.

That's the shift. Compose tells the machine what to do. Kubernetes tells it what should be true. When something drifts, the cluster pulls it back. When I redeploy, I'm not hoping the previous state cleaned up properly. I'm declaring the new one.

## How it actually went

Smoothly. I deployed the whole thing from my laptop with `kubectl`, pointed at the cluster on my VPS. Certificates issued themselves through cert-manager and Let's Encrypt. No frenzy.

The first deploy took longer than a compose file would have. Every deploy since has been faster, more predictable, and easier to reason about.

## Why this matters for solo devs

The pitch for Kubernetes is almost always about scale: surviving a Hacker News hug of death, autoscaling across regions, surviving node failures at 3am. None of that applies to me. I have one VPS and not many users.

What I got instead:

- Declarative management. Cluster state lives in a Git repo. Everything is version-controlled.
- Quick deployments. `kubectl apply -f` and walk away.
- Consistent output. The cluster converges to what the manifests say. No more "works on my VPS."

Kubernetes isn't just about scale. For a solo dev, it's about not having to remember things. The cluster remembers for you.

