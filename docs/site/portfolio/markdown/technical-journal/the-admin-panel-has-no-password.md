# The admin panel has no password

I've been building this site as a creative outlet, a place to ship something for myself and stretch into web design a bit more. I'm a backend developer in my day job, so getting properly hands-on with React and Svelte has been a nice change of pace (a topic for another day). The [previous post](https://osinachi.nwagboso.com/blog/my-k3s-experience) covered how it gets deployed onto my K3s cluster. This one is about a smaller decision I made along the way.

The management side of the site has no password.

That sentence reads worse than it is. I didn't replace authentication with nothing. I replaced it with passkeys. There's still a strong cryptographic check between me and the admin interface, it just isn't a string I have to remember. The more I sat with the decision, the more it became a useful lens on a question I don't think we ask often enough: when is a password actually doing security work, and when is it just there because we expect it to be?

## Where passwords start to be theatre

Passwords are the default for good reasons. They're universally understood, work on any device, and are easy to provision. For a system with many users and varied threat models, a password backed by a manager and a second factor is a sensible floor.

But passwords carry failure modes that have nothing to do with how strong the password itself is. They get phished. They get reused. They get leaked in breaches of unrelated services and sprayed at every login form on the internet. A password on a single-user admin panel, defended only by "I am the only one who knows it," is doing less work than it appears to be. The strength of that control isn't really the password. It's the obscurity of the URL plus my personal vigilance, and neither belongs in a threat model with a straight face.

## What passkeys change

Passkeys are a different shape of control. The private key never leaves my device. The challenge is bound to the origin, so a phishing site can't replay it against the real one. There's no shared secret sitting in a database to leak. And the UX is better than a password: Touch ID and I'm in.

For a single-user admin interface, this is a near-perfect fit. The threat I actually care about is someone on the internet reaching my admin panel, and passkeys make that materially harder than a password would while removing phishing almost entirely.

The obvious caveat: passkeys are tied to devices, so you need a recovery story. I use 1Password for sync, which keeps them portable across the machines I actually use.

## So when is a password the right call?

I don't want to land on "passwords are bad." That's the wrong takeaway. A password is a tool with a specific shape, and you pick it when the shape fits.

It fits when you have many users on heterogeneous devices, when you can't guarantee passkey support, or when you need a credential that can be handed off out-of-band. It's theatre when it's the only control on a high-value surface, when users will inevitably reuse it, or when something stronger (passkeys, mTLS, a network boundary, SSO) is genuinely available and you're defaulting to a password out of habit.

## The actual lesson

My decision wasn't "skip the password because it's annoying." It was "the threat I'm defending against is internet-scale credential abuse, and there's a control that handles that better than a password does." The fact that it's also more pleasant is a bonus, not the justification.

Hardening systems is mostly about being honest about what each control does. A password you can't be bothered to remember isn't hardening anything. It's just a worse version of the control you'd pick if you were thinking clearly.

