# Pappu Pictures Design System

This game-specific design system preserves the existing Andar Bahar documentation in `docs/design.*`. It is mirrored in `docs/pappu-design.html`.

## Visual direction

The cabinet is a portrait, live picture-betting machine inspired by the supplied recording: polished emerald felt, purple pennant-shaped roadmap cards, pale glossy picture tiles, yellow-gold betting highlights and tactile casino chips. The composition is intentionally dense and toy-like, but all values use crisp, high-contrast type.

## Color tokens

- Deep felt: `#004b34`
- Main felt: `#007a4d`
- Bright felt: `#00a466`
- Live green: `#67ff9b`
- Purple card: `#7950a1`
- Card silver: `#d7d9e9`
- Reward gold: `#ffd737`
- Danger red: `#d91d22`
- Ink: `#143e2d`
- Text: `#f5fff7`

## Type and depth

Use Avenir Next/Inter for controls and tabular values, with Impact/Arial Black reserved for the PAPPU display mark. Controls use one bright inner highlight, one dark lower edge and a single cast shadow. Do not stack blur glows or animate continuous highlights.

## Geometry

The source frame is `430 × 880` and scales uniformly, preserving hit targets and aspect ratio. Roadmap is exactly `6 × 6`; picture choices are exactly `6 × 2`. Picture cells are never rearranged between rounds. Touch targets remain at least 52px in the design coordinate system.

## Motion

The result is one server-synchronized picture. During reveal, the roadmap dims, one large pennant flips once, then the winning picture and multiplier appear. The newest roadmap cell receives one short pop. Chip presses move down by 2px. No flickering, looping win glows or moving hit regions.

## Components

- Live top bar: back, LIVE MODE, INR balance, sound.
- Statistical strip: History plus top three pictures from the latest 100 rounds.
- Brand zone: original child mascot treatment and PAPPU PICTURES mark.
- Roadmap: 36 chronological result cards with future spaces face-down.
- Phase banner: Please Bet Now, Bet Locked/Extra Pay, then the result.
- Picture bet grid: 12 fixed pictures and precise per-picture chip totals.
- Chip fan: ₹10, ₹20, ₹30, ₹50, ₹100 and ₹200.
- Actions: Again, Double, Undo and Clear.

## Do / don't

Do keep all users on the same result. Do keep selection and settlement identifiers textual and stable. Do show INR and LIVE MODE. Do use the server's min/max. Don't derive results in the production client. Don't cover the picture cells with modal chrome. Don't copy a real player's portrait from the recording.
