# MiRemoteV 2ch source

Axonkey builds `MiRemoteV2ch.driver` from BlackHole v0.7.1 at commit
`e2b22aaaba4e507a097131704bf96dabc004d9cf`.

`blackhole-device-usb.patch` changes the reported Core Audio transport to USB
and assigns a distinct CFPlugIn factory UUID. Build settings provide the
`MiRemoteV` name, `com.hd838a.MiRemoteV2ch` bundle identifier, and two-channel
layout. The resulting device UID is `MiRemoteV2ch_UID`; it can coexist with an
unmodified BlackHole installation.

BlackHole is GPL-3.0 licensed. Complete corresponding upstream source is at
<https://github.com/ExistentialAudio/BlackHole/tree/e2b22aaaba4e507a097131704bf96dabc004d9cf>.
