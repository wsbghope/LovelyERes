# LovelyRes Offline Capture Tool

LovelyRes includes architecture-specific static builds of `tcpdump` for
offline incident-response targets.

- Build project: https://github.com/0typos/statics
- Pinned release: `v2026.08.01`
- tcpdump: `4.99.6` (`BSD-3-Clause`)
- libpcap: `1.10.6` (`BSD-3-Clause`, statically linked)
- C library: musl
- Build target: baseline Linux CPU for each architecture

The release archives were downloaded through the GitHub Releases API and
accepted only after their GitHub-published SHA-256 digests matched. LovelyRes
ships only the `tcpdump` executable from each archive, not the complete
troubleshooting toolkit.

The tcpdump, libpcap, and musl license/copyright texts are included under
`licenses/`.
