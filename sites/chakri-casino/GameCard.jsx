/**
 * Drop-in replacement for the Vinext ChakriSite GameCard.
 *
 * Live bundle (https://chakri.casino/_next/static/chunks/ChakriSite-*.js):
 *   function Wm({ game }) — article.game-card with a circular gold <a.play-button>
 *   whose accessible name is "Open {name}" and whose only child is ArrowRight.
 *
 * This is NOT the React lobby GameCard in frontend/src/components/GameCard.js.
 * chakri.casino apex is the Sites app; FunGame-Admin cannot publish these cards.
 *
 * Keep GameVisual (`Um`) unchanged. Keep NativeLink (`$`) so play still goes to
 * `/games/{slug}/play` (Render GamePlay + RequireAuth login gate).
 */

import { ArrowRight, PauseCircle } from "@phosphor-icons/react";
import { motion } from "framer-motion";

export function GameCard({ game, GameVisual, NativeLink }) {
  const ready = game.status === "active";
  const playHref = `/games/${game.slug}/play`;

  const copy = (
    <div className="game-card-copy">
      <div>
        <h3>{game.name}</h3>
        <p>{game.category}</p>
      </div>
      {ready ? (
        <span className="play-button" aria-hidden="true">
          <span className="play-button-motion">
            <b>PLAY NOW</b>
            <span className="play-button-arrow">
              <ArrowRight size={20} weight="fill" />
            </span>
          </span>
        </span>
      ) : (
        <span
          className="play-button is-disabled"
          aria-label={`${game.name} is not currently available`}
          aria-disabled="true"
        >
          <PauseCircle size={19} weight="fill" />
        </span>
      )}
    </div>
  );

  return (
    <motion.article
      className="game-card"
      style={{ transformPerspective: 900 }}
      whileHover={{ y: -6, rotateX: 1.4, rotateY: -0.8, scale: 1.015 }}
      whileTap={{ scale: 0.985 }}
      transition={{ type: "spring", stiffness: 280, damping: 24 }}
    >
      {ready ? (
        <NativeLink
          className="game-card-hit"
          href={playHref}
          data-native-navigation="true"
          aria-label={`Play ${game.name}`}
        >
          <GameVisual game={game} />
          {copy}
        </NativeLink>
      ) : (
        <>
          <GameVisual game={game} />
          {copy}
        </>
      )}
    </motion.article>
  );
}

/**
 * Minified-source swap for `function Wm({game:e})` when NativeLink is `$`,
 * GameVisual is `Um`, ArrowRight is `ne`, PauseCircle is `we`, motion is `ad`:
 *
 *   function Wm({game:e}){
 *     let t=e.status===`active`;
 *     let n=`/games/${e.slug}/play`;
 *     let r=(0,q.jsxs)(`div`,{className:`game-card-copy`,children:[
 *       (0,q.jsxs)(`div`,{children:[(0,q.jsx)(`h3`,{children:e.name}),(0,q.jsx)(`p`,{children:e.category})]}),
 *       t?(0,q.jsx)(`span`,{className:`play-button`,"aria-hidden":`true`,children:(0,q.jsxs)(`span`,{className:`play-button-motion`,children:[(0,q.jsx)(`b`,{children:`PLAY NOW`}),(0,q.jsx)(`span`,{className:`play-button-arrow`,children:(0,q.jsx)(ne,{size:20})})]})}):(0,q.jsx)(`span`,{className:`play-button is-disabled`,"aria-label":`${e.name} is not currently available`,"aria-disabled":`true`,children:(0,q.jsx)(we,{size:19})})
 *     ]});
 *     return (0,q.jsxs)(ad.article,{className:`game-card`,style:{transformPerspective:900},whileHover:{y:-6,rotateX:1.4,rotateY:-.8,scale:1.015},whileTap:{scale:.985},transition:{type:`spring`,stiffness:280,damping:24},children:[
 *       t?(0,q.jsxs)($,{className:`game-card-hit`,href:n,"aria-label":`Play ${e.name}`,children:[(0,q.jsx)(Um,{game:e},`${e.slug}:${e.artworkUrl||`mark`}`),r]}):[(0,q.jsx)(Um,{game:e},`${e.slug}:${e.artworkUrl||`mark`}`),r]
 *     ]});
 *   }
 */
