# Scry identity

An abstract two-part S with an open path through its centre: following a testing
journey and making its evidence clear. The identity is not based on a lock, shield,
generic eye icon or AI sparkle. The green symbol stands alone on a genuinely
transparent background, without a tile, container, shadow or glow.

Production artwork lives in `apps/web/public/brand/`:

- `scry-symbol.svg`: the canonical standalone green symbol with no background;
- `scry-logo.svg` / `scry-logo.png`: wordmark for dark backgrounds;
- `scry-logo-light.svg` / `scry-logo-light.png`: wordmark for light backgrounds;
- `scry-icon-512.png`: square logo suitable for a provider's branding upload;
- `scry-icon-192.png`: install icon;
- `favicon-16.png`, `favicon-32.png`, `favicon-48.png`: small-size exports.

The root public assets include `favicon.svg`, a three-size `favicon.ico`, an
180-pixel `apple-touch-icon.png` and `site.webmanifest`. The favicon SVG is an exact
copy of the symbol. Keep the path geometry synchronized across the wordmarks;
the brand tests enforce this. The app uses the shared `BrandMark` component.
Functional eye icons in navigation or feature descriptions are not brand marks.

Colors: lime `#C7F36B` on dark backgrounds, deeper green `#4D7C0F` for legibility on
light backgrounds, ink `#090B0D`, light wordmark `#EDF1F4`. The editable SVG
wordmarks use Arial/Helvetica/sans-serif bold; the transparent PNGs preserve the
exported typography when an upload needs consistent raster artwork. There are no
external font requests or linked images in the SVG assets. Preserve the aspect
ratio and leave at least half a symbol's height clear around standalone lockups.

## Creation record

The current background-free design is a direct native SVG revision requested after
reviewing the boxed exploration. Its tighter framing keeps the naked symbol clear
at small sizes. App wrappers are also background-free. All PNG and ICO exports
were regenerated from these revised vectors. The original generation prompts below
record the initial exploration, not the current background treatment.

Mode: built-in image generation, followed by custom native SVG production artwork.
The selected generated exploration is retained as `scry-generated-concept.png`;
it is not served by the application. Its form informed the vector symbol. The
production SVG replaces the exploration's texture and edge fringe with exact flat
colors, precise paths and clean transparency. PNG and ICO files were rendered
offline from that same SVG, not independently generated or visually reconstructed.
No runtime image-generation dependency is added. No trademark clearance is implied.

Initial generation prompt:

> Use case: logo-brand. Asset type: production logo symbol and favicon master for Scry, a professional software testing platform. Create ONE exceptionally refined, original symbol, not a sheet of options. Direction: a compact, sculptural abstract S formed by two complementary, offset geometric bands with beautifully balanced negative space; the central open path subtly suggests following a journey and seeing it clearly. It should feel distinctive, confident, contemporary and calm, with a memorable silhouette that remains unmistakable at 16 pixels. More considered brand identity than a generic font glyph. Precision, balanced proportions, solid thick forms and slightly softened corners, restrained diagonal cuts. Render the symbol in solid near-black ink #090B0D centered on a solid luminous pale lime #C7F36B rounded-square tile. The tile takes roughly 88 percent of a square canvas; actual transparency only outside the rounded tile. No wordmark or letters outside the symbol, no captions, no typography, no extra elements. Flat vector-like artwork with perfectly crisp clean edges. No eye, no shield, no lock, no checkmark, no magnifying glass, no star, no sparkle, no lightning bolt, no gradients, no shadows, no glow, no textures, no 3D, no mockup, no watermark. Deliver a single large square icon with genuinely transparent corners outside its lime tile.

Targeted refinement prompt, using the generated concept as the edit target:

> Use case: logo-brand, precise-object-edit. This image is the edit target, the selected Scry logo. Preserve its exact two-part abstract S silhouette, proportions, central opening, tile shape and centered composition. Make ONE production-clean refinement only: remove every gradient, shadow, texture, halo, edge fringe, stray pixel and speck outside the tile. All lime pixels inside the rounded square should be exactly one uniform flat #C7F36B fill, all dark mark interiors exactly uniform #090B0D. Crisp smooth antialiased curves and diagonal edges. The area outside the rounded square must be completely transparent and entirely clean, including all four corners and the outer canvas edges. Do not redesign the mark, add text, change the geometry, introduce new colors, or add any lighting or decorative treatment. Single square logo icon, not a presentation board.
