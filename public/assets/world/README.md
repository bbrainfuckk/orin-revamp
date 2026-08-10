# Scroll-world media layout

- `stills/`: approved scene posters and fallback artwork.
- `video/`: scrub-ready desktop clips and optional `-m.mp4` mobile variants.

Generated media is added only after mascot identity and scene-style review.

## Current production manifest

1. `01-inquiry-arrives-clean-v2.mp4` — customer inquiry at home.
2. `02-commerce-studio-clean-v2.mp4` — home e-commerce fulfillment.
3. `03-guest-checkin-clean-v2.mp4` — guest arrival and check-in.
4. `04-care-navigation-clean-v2.mp4` — hospital reception handoff.
5. `05-human-handoff-clean-v2.mp4` — public-service inquiry and human handoff.
6. `06-morning-finale-clean-v2.mp4` — connected-community sunrise finale.

Each desktop clip has a `-m.mp4` sibling: a 1280×720 HD, GOP-4 encode reserved for Save-Data and extremely memory-constrained devices. Normal phones and desktops receive the highest available 1920×1080 master. All clips run at 24 fps. These sources are native 1080p—not 4K—and must not be upscaled because that adds decode cost without adding detail. The `clean-v2` suffix is a cache-busting release marker for the watermark-free source set.

Production serves byte ranges, so the browser streams each MP4 directly. Autoplay uses sequential native playback; manual scroll uses bounded, on-demand seeking. Keep only the active clip and the next clip warm.
