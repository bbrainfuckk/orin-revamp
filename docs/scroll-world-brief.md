# ORIN Scroll World — Draft Production Brief

## Product premise

ORIN is the 24/7 AI front desk for Facebook Messenger. It answers routine inquiries, understands text, voice notes, and images, collects useful details, supports sales and service, and routes important cases to the right human.

The first draft follows one inquiry through the communities ORIN can support: an online seller, a guest stay, routine hospital administration, and a human handoff. Hospitals and public-service scenes must stay administrative and non-emergency; people remain responsible for care, safety, and escalation.

## Design direction

**Cinematic scroll world.** Dark, media-led, architectural, and controlled. The interface stays quiet while the mascot travels through one connected handcrafted 3D world.

- No generic glass-card grids or dashboard filler.
- No purple “AI” gradients.
- No written UI, signage, logos, or generated text inside the footage.
- No random montage cuts; each shot continues the same left-to-right journey.
- No claim that ORIN diagnoses, dispatches, or makes high-stakes decisions.

## Brand system

| Role | Name | Value |
| --- | --- | --- |
| Background | ORIN Void | `#050706` |
| Primary text | Morning Paper | `#F1F6EE` |
| Signal | ORIN Signal | `#54F99B` |
| Character light | Leaf Light | `#B8F2A1` |
| Structure | Moss Metal | `#305B39` |
| Finale accent | First Light | `#D7B66F` |

Tone: vigilant, capable, warm, direct.

## Mascot identity lock

Reference: `public/assets/brand/orin-mascot-original.webp`

Every translation must preserve the rounded-square face window, two oval eyes, small curved smile, cheek lights, side pods, centered sprout, compact rounded body, and leaf chest emblem. ORIN should never become humanoid, armored, aggressive, or uncanny.

Current 3D master: `public/assets/brand/orin-mascot-3d-master.webp`

## Current six-chapter journey

1. **Inquiry — Every inquiry, answered.** A customer messages from home after hours; ORIN begins the journey.
2. **Commerce — Questions become orders.** ORIN crosses a private home e-commerce fulfillment and product-photo studio.
3. **Guest stays — Guests know what happens next.** The path continues into a condominium arrival and check-in moment.
4. **Care — The right question finds the right desk.** ORIN guides a routine hospital reception inquiry toward staff.
5. **Handoff — Sensitive cases reach a person.** Temporary still in this draft; replace with the public-service/human-handoff clip.
6. **Morning — No one starts from zero.** Temporary 3D mascot portrait in this draft; replace with the final morning scene.

## Camera and generation lock

- One continuous side-scrolling journey assembled from sequential continuity-locked legs.
- ORIN moves consistently toward screen-right.
- Start each new shot from the prior shot’s actual final frame.
- End behind a clean foreground occluder so the next environment can continue naturally.
- Full-bleed 16:9, no text, no logos, no watermark, no dialogue.
- Final generation model: Veo 3.1 Pro in Google Flow.

## Current asset status

The source folder contains five files but only four unique videos: its two traveler clips are byte-for-byte identical. Scrub-ready web encodes and fallback posters live under `public/assets/world/`.

Outstanding for the complete journey:

- Chapter 5 public-service/human-handoff video.
- Chapter 6 morning finale video.

## Mobile and low-spec scope

The draft keeps the 1920×1080 masters for stronger desktops and serves dedicated 1280×720 HD, GOP-4 encodes to phones, data-saver connections, and lower-memory/CPU devices. Lite mode also keeps fewer video decoders alive, stops off-screen seeking, removes atmosphere effects, and releases video memory before the ROI section. A future 9:16 render remains optional after all six desktop shots are approved.
