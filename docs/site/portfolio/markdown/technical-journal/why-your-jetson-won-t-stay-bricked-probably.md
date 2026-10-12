# Why Your Jetson Won't Stay Bricked (Probably)

I always wondered what WSL (Windows Subsystem for Linux) was actually for.

Why not just use Linux? It always felt like a strange amount of work to avoid buying a cheap ThinkPad, dual booting, or spinning up a VM. I never really saw the point. Then I started working with Jetsons.

For context, we use quite a few of them at work because a lot of what we do involves AI at the edge. Vehicle tracking, image processing, and inference running somewhere that doesn't have the luxury of shoving everything into the cloud. CUDA has always been a bit of a pain in this space. It has improved considerably with CUDA 12, but there are still enough moving parts that cause people pain.

We also work with the Home Office, which means once something has been deployed it doesn't move very quickly. If a system was validated on a particular JetPack release, there is a decent chance it stays there for quite a while. That's how you end up supporting several JetPack versions at the same time instead of simply upgrading everything and forgetting about it.

## The version problem nobody mentions

NVIDIA ties JetPack releases fairly closely to host Ubuntu versions.

JetPack Host Ubuntu 4.x - 18.04, 5.x - 20.04, 6.x - 22.04

That sounds harmless until you're supporting several projects at once.

Without WSL, your options are fairly uninspiring.

| Approach | Reality |
| --- | --- |
| Dedicated flashing machine | Works, but you've committed an entire system to one purpose. |
| Multiple partitions | Fine until you're rebooting several times a day. |
| Several old laptops | Also works, but no one wants a growing pile of Ubuntu machines under their desk. |
| Virtual machines | Sounds sensible until USB passthrough starts behaving unpredictably halfway through a flash. |
| WSL | Open an 18.04 shell, do the flash, close it, then move to 20.04 or 22.04 when needed. Or even have all devices being flashed at the same time (Don't forget to use Usbpid to make the USB visible to WSL.) |

## You usually don't touch [flash.sh](http://flash.sh)

Another thing that surprised me when I started was how little people actually interact with [flash.sh](http://flash.sh).

SDK Manager does most of the work.

- It downloads the BSP.
- It prepares the root filesystem.
- It invokes the flashing tools.

Most people probably never even notice the underlying commands.

That changes fairly quickly once custom hardware appears.

A lot of carrier board vendors provide their own patches, device trees, kernel tweaks, pin mux settings, or partition layouts. At some point someone sends you a tarball and a PDF containing instructions that basically translate to:

> Please read this carefully because support does not want to talk to you tomorrow.

That patch file isn't optional.

Skip it, apply the wrong one, or patch the wrong L4T version and you suddenly have a £3,000 box that doesn't boot.

The really frustrating bit is that it often doesn't tell you why it doesn't boot because the thing that would normally explain what is wrong was part of the thing you forgot to patch.

## Jetsons are harder to brick than people think

The good news is that Jetsons are surprisingly forgiving.Most failed flashes aren't actually bricks. They just end up back in recovery mode waiting for another attempt.

The failure modes usually look something like this.

| What went wrong? | Can recovery mode save it? |
| --- | --- |
| Corrupted root filesystem | Yes |
| Wrong device tree | Yes |
| Half written bootloader | Yes |
| Bad kernel image | Yes |
| Incorrect partition layout | Usually |
| Burned security fuses | No |

Force Recovery Mode lives in the BootROM. It's part of the silicon itself, not something stored in eMMC, QSPI, or Linux.

- Broken root filesystem?
- Wrong device tree?
- Half written bootloader?
- It doesn't really care.

Put the board back into recovery mode and it'll sit there patiently

## The takeaway

WSL finally made sense to me once I stopped thinking about it as "Linux on Windows."

For Jetson development, it's more like having three Ubuntu machines stuffed into one laptop.

That isn't obvious from Microsoft's marketing, and it certainly isn't obvious from NVIDIA's documentation.

It's just one of those things you eventually appreciate after flashing your fifth board on a Tuesday afternoon and noticing that you haven't rebooted your workstation once.

