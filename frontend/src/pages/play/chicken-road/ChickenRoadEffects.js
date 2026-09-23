import { useId } from "react";
import "./chicken-road-effects.css";

function FlamePaint({ id }) {
  return <defs>
    <linearGradient id={`${id}-edge`} x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stopColor="#ffbd32" /><stop offset=".36" stopColor="#ff691c" />
      <stop offset=".78" stopColor="#ef3c0f" stopOpacity=".9" /><stop offset="1" stopColor="#c52910" stopOpacity=".25" />
    </linearGradient>
    <linearGradient id={`${id}-core`} x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stopColor="#fffbe4" /><stop offset=".24" stopColor="#fff28a" />
      <stop offset=".55" stopColor="#ffd039" /><stop offset=".82" stopColor="#ff921c" />
      <stop offset="1" stopColor="#ff5c14" stopOpacity=".55" />
    </linearGradient>
  </defs>;
}

/**
 * Decorative, finite collision effect. Mount once for each collision (use a
 * round key when reusing the same lane). Its parent must be positioned.
 * Four drawn contours alternate through a clearly visible 1400 ms burst.
 */
export function FireBurst({ durationMs = 1400, className = "" }) {
  const paint = `road-fire-${useId().replace(/:/g, "")}`;
  const duration = Number.isFinite(durationMs) ? Math.max(400, Math.min(1800, durationMs)) : 1400;
  return <div className={`road-fx-burst ${className}`.trim()} style={{ "--road-fx-duration": `${duration}ms`, "--road-fire-edge": `url(#${paint}-edge)`, "--road-fire-core": `url(#${paint}-core)` }} aria-hidden="true">
    <div className="road-fx-burst-glow" />
    <div className="road-fx-jet">
      <svg className="road-fx-stream" viewBox="0 0 100 600" preserveAspectRatio="none" focusable="false">
        <FlamePaint id={paint} />
        <g className="road-fx-contour road-fx-contour--a">
          <path className="road-fx-rim" d="M18 615C8 566 34 543 22 493C7 438 36 408 27 357C17 311 36 279 24 228C13 181 31 145 18 107C9 82 23 58 12 16L21 29C31 2 27-15 23-35C33-68 32-91 44-118C61-89 46-62 58-37C72-57 69-71 78-91C89-64 79-47 87-35C99 19 66 56 86 115C102 166 69 208 84 260C100 314 69 357 76 405L87 373C102 432 70 465 83 520C94 560 87 587 91 615Z" />
          <path className="road-fx-core" d="M30 615C19 569 47 522 36 469C22 413 49 380 44 329C36 275 58 245 45 200C33 153 49 118 36 78C30 48 47 6 41-35C44-49 42-70 45-88C54-62 52-48 58-25C66-43 68-49 72-63L77-35C86 27 61 64 72 115C82 165 61 207 67 246C76 295 55 330 59 374C65 421 50 466 60 510C68 548 70 583 72 615Z" />
          <path className="road-fx-lick" d="M29 483C26 421 50 405 50 351C44 382 27 398 24 430ZM58 339C58 275 78 250 75 200C71 237 52 259 53 296ZM39 206C32 163 38 139 48 104C46 151 50 172 39 206ZM64 615C54 567 69 534 62 493C59 533 47 559 52 590Z" />
        </g>
        <g className="road-fx-contour road-fx-contour--b">
          <path className="road-fx-rim" d="M11 615C24 568 8 522 31 482C54 439 21 396 27 352L12 378C6 337 39 300 27 248C15 198 42 165 32 119C19 72 38 33 26-35C29-67 45-79 43-115C59-87 48-65 58-47L65-65C76-44 73-64 83-84L84-35C100 26 72 69 88 112L96 82C106 145 75 173 79 221C85 270 62 299 72 342C91 397 60 427 80 482C95 523 72 576 89 615Z" />
          <path className="road-fx-core" d="M27 615C36 575 25 531 46 493C65 451 41 413 42 369C42 329 61 299 46 252C34 206 56 176 51 132C44 82 58 39 45-35C48-56 44-67 45-87C61-65 50-53 58-30L69-55L75-35C88 20 61 63 74 112C86 166 60 191 63 232C64 281 47 310 59 354C74 400 48 437 62 480C75 528 52 567 69 615Z" />
          <path className="road-fx-lick" d="M27 571C24 518 47 500 48 456C36 495 18 511 21 545ZM54 407C67 365 50 336 58 296C41 328 49 365 54 407ZM37 286C28 227 46 207 51 171C34 204 21 230 27 262ZM62 153C59 112 79 83 80 47C66 80 52 98 55 126Z" />
        </g>
        <g className="road-fx-contour road-fx-contour--c">
          <path className="road-fx-rim" d="M20 615C7 565 32 528 18 480L7 498C-1 443 29 418 27 369C25 322 48 284 33 241C17 192 41 163 26 116C9 67 30 16 19-35C24-63 40-75 36-112C54-89 50-65 59-43C69-62 70-78 69-93C87-74 78-50 91-35C96 28 71 67 81 110C93 158 65 191 80 238L91 211C103 268 71 304 73 352C75 397 56 433 74 476C92 523 73 567 87 615Z" />
          <path className="road-fx-core" d="M33 615C19 567 48 529 37 488C24 443 45 412 44 374C44 326 65 296 51 246C37 196 60 163 46 115C32 67 52 17 40-35C45-60 41-70 42-82C56-62 51-44 58-23L70-66L79-35C83 31 58 69 68 112C80 158 54 188 62 237C72 279 49 313 57 355C67 396 46 432 57 475C71 521 56 568 67 615Z" />
          <path className="road-fx-lick" d="M34 586C28 550 43 522 39 485C33 516 19 539 25 566ZM62 464C52 426 69 397 70 361C55 390 45 418 48 442ZM42 340C40 291 57 264 48 225C47 257 31 282 32 309ZM61 236C69 199 58 173 64 135C48 170 56 196 61 236ZM32 117C24 65 47 49 43 14C35 48 16 65 23 95Z" />
        </g>
        <g className="road-fx-contour road-fx-contour--d">
          <path className="road-fx-rim" d="M14 615C27 570 14 539 31 494C48 448 21 415 24 371C28 320 14 296 29 250C46 202 19 174 30 129L15 151C7 113 37 74 23 25L13-35C25-47 32-76 28-102C48-87 48-63 45-42C64-61 53-86 68-117C82-88 78-64 83-35C100 20 72 60 86 100C101 149 69 179 76 224C86 268 63 304 79 349L91 323C99 375 66 405 75 450C88 497 67 542 84 582L88 615Z" />
          <path className="road-fx-core" d="M28 615C39 572 30 541 48 498C65 454 42 423 42 381C47 333 31 299 44 257C58 209 37 179 47 132C59 88 46 52 38 15L35-35C40-54 37-67 34-80C49-65 48-44 49-26C60-45 60-65 69-86C78-65 72-45 74-35C83 19 62 56 72 103C86 151 57 180 61 226C67 270 48 310 62 351C75 397 49 423 59 466C72 512 53 551 67 590L70 615Z" />
          <path className="road-fx-lick" d="M57 615C48 563 69 542 62 496C55 533 40 557 45 590ZM33 492C42 447 27 423 34 383C20 412 30 454 33 492ZM61 387C59 342 74 322 71 278C65 313 49 335 53 365ZM40 285C31 246 45 221 48 187C31 218 26 244 32 265ZM60 163C52 120 65 97 66 60C56 90 41 112 48 141Z" />
        </g>
      </svg>
    </div>
    <div className="road-fx-fragments">
      <svg className="road-fx-fragment road-fx-fragment--a" viewBox="0 0 100 170" preserveAspectRatio="none" focusable="false">
        <path className="road-fx-rim" d="M28 167C3 123 12 98 30 76C46 54 39 31 49 3C66 31 49 49 62 73C78 100 65 124 75 160C47 132 56 112 46 102C33 126 39 147 28 167Z" />
        <path className="road-fx-core" d="M30 137C19 111 32 90 41 77C56 56 47 45 50 28C60 54 51 70 64 94C71 110 62 121 66 140C53 125 52 101 46 89C31 106 36 121 30 137Z" />
      </svg>
      <svg className="road-fx-fragment road-fx-fragment--b" viewBox="0 0 100 170" preserveAspectRatio="none" focusable="false">
        <path className="road-fx-rim" d="M61 166C39 137 48 107 31 93C24 86 17 89 10 99C7 66 32 60 36 39C40 24 36 13 43 3C60 15 54 42 65 61C84 94 65 122 61 166Z" />
        <path className="road-fx-core" d="M59 135C51 105 50 79 32 74L22 82C31 66 45 61 47 40L46 23C53 50 57 62 63 79C69 97 61 114 59 135Z" />
      </svg>
      <svg className="road-fx-fragment road-fx-fragment--c" viewBox="0 0 100 170" preserveAspectRatio="none" focusable="false">
        <path className="road-fx-rim" d="M15 148C18 112 41 105 44 78C48 53 38 34 53 3C52 48 79 68 76 93C74 119 54 127 62 165C40 151 42 132 42 120C32 129 25 134 15 148Z" />
        <path className="road-fx-core" d="M32 125C46 104 57 87 53 67C63 79 70 97 60 113C49 130 52 134 52 144C43 129 48 111 47 109Z" />
      </svg>
    </div>
    <div className="road-fx-embers">
      <i /><i /><i /><i /><i /><i /><i /><i />
    </div>
  </div>;
}

/** Small background grate flame. The lane only staggers decoration, never odds. */
export function AmbientFlame({ lane = 0, className = "" }) {
  const paint = `road-pilot-${useId().replace(/:/g, "")}`;
  const index = Number.isFinite(lane) ? Math.abs(lane) : 0;
  return <span className={`road-fx-ambient ${className}`.trim()} style={{ "--road-fx-delay": `${-((index * 1373) % 7800)}ms`, "--road-fire-edge": `url(#${paint}-edge)`, "--road-fire-core": `url(#${paint}-core)` }} aria-hidden="true">
    <span className="road-fx-pilot-glow" />
    <svg className="road-fx-pilot" viewBox="0 0 36 56" preserveAspectRatio="none" focusable="false">
      <FlamePaint id={paint} />
      <path className="road-fx-wisp road-fx-wisp--left" d="M9 54C1 44 2 36 6 27C12 16 8 11 13 3C11 20 19 24 13 34C8 42 15 48 9 54Z" />
      <path className="road-fx-pilot-edge" d="M17 54C4 52 4 41 8 34C13 25 12 19 11 15C16 19 16 25 16 25C22 17 17 10 23 2C22 18 33 24 28 35C33 32 34 29 34 26C39 43 29 57 17 54Z" />
      <path className="road-fx-pilot-core" d="M18 51C10 50 11 42 15 37C20 31 18 26 21 22C24 33 30 38 26 45C23 52 20 52 18 51Z" />
    </svg>
    <i className="road-fx-pilot-ember" /><i className="road-fx-pilot-ember road-fx-pilot-ember--second" />
  </span>;
}
