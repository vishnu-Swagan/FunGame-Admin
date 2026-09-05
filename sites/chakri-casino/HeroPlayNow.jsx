/**
 * Drop-in inner content for the ChakriSite hero primary button
 * (`a.button.button-primary` → `/casino`, currently " Play now" with no loop).
 *
 * Live markup:
 *   <a class="button button-primary" href="/casino">
 *     <Play weight="fill" /> Play now
 *   </a>
 */

import { Play } from "@phosphor-icons/react";

export function HeroPlayNowLabel() {
  return (
    <span className="hero-play-now-motion">
      <Play weight="fill" />
      <b>Play now</b>
    </span>
  );
}
