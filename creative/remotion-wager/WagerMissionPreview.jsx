import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

const FPS = 30;
const GOLD = "#F4C24A";
const GOLD_PALE = "#FFE9A8";
const EMERALD = "#24C98A";
const MIDNIGHT = "#070B14";
const PANEL = "rgba(16, 23, 38, 0.92)";
const TEXT = "#F8F5EA";
const MUTED = "#9CA7BA";
const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);

const clamp = (frame, input, output, easing = Easing.linear) =>
  interpolate(frame, input, output, {
    easing,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

const rupees = (amount) => `₹${Math.round(amount).toLocaleString("en-IN")}`;

function Shell() {
  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(circle at 50% 19%, rgba(244,194,74,.14), transparent 34%), radial-gradient(circle at 50% 74%, rgba(36,201,138,.08), transparent 42%), linear-gradient(180deg, #0A1020 0%, #070B14 52%, #04070D 100%)",
        color: TEXT,
        fontFamily: "Manrope, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.16,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage: "linear-gradient(to bottom, transparent, black 26%, black 76%, transparent)",
        }}
      />
      <div
        style={{
          position: "absolute",
          zIndex: 30,
          left: 64,
          right: 64,
          top: 54,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 22,
          fontWeight: 800,
          letterSpacing: ".12em",
          textTransform: "uppercase",
        }}
      >
        <span style={{ color: GOLD_PALE }}>Chakri.Casino</span>
        <span
          style={{
            border: "1px solid rgba(255,255,255,.15)",
            borderRadius: 999,
            padding: "11px 18px",
            color: "#D9DFEA",
            fontSize: 17,
            letterSpacing: ".09em",
          }}
        >
          Concept preview · mock amounts
        </span>
      </div>
    </AbsoluteFill>
  );
}

function StatusPill({ children, color = GOLD }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        alignSelf: "flex-start",
        border: `1px solid ${color}55`,
        borderRadius: 999,
        padding: "13px 19px",
        color,
        background: `${color}12`,
        fontSize: 20,
        fontWeight: 800,
        letterSpacing: ".07em",
        textTransform: "uppercase",
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 18px ${color}`,
        }}
      />
      {children}
    </div>
  );
}

function Stat({ label, value, accent = TEXT }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          color: MUTED,
          fontSize: 21,
          fontWeight: 650,
          lineHeight: 1.3,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 7,
          color: accent,
          fontSize: 34,
          fontWeight: 850,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-.025em",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function PaymentReceipt() {
  const frame = useCurrentFrame();
  const enter = clamp(frame, [0, 20], [0, 1], EASE_OUT);
  const exit = clamp(frame, [51, 71], [0, 1], Easing.in(Easing.cubic));
  const presence = enter * (1 - exit);

  return (
    <AbsoluteFill
      style={{
        padding: "190px 72px 96px",
        opacity: presence,
        transform: `translateY(${(1 - enter) * 34 - exit * 28}px) scale(${0.985 + enter * 0.015})`,
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: 116,
            height: 116,
            display: "grid",
            placeItems: "center",
            border: `2px solid ${EMERALD}77`,
            borderRadius: 36,
            color: EMERALD,
            background: "rgba(36,201,138,.1)",
            boxShadow: "0 24px 70px rgba(36,201,138,.13)",
            fontSize: 62,
            fontWeight: 900,
          }}
        >
          ✓
        </div>

        <div style={{ marginTop: 48 }}>
          <StatusPill color={EMERALD}>Payment verified</StatusPill>
          <h1
            style={{
              margin: "31px 0 0",
              maxWidth: 820,
              fontSize: 90,
              lineHeight: 0.98,
              letterSpacing: "-.055em",
            }}
          >
            Deposit received
          </h1>
          <p
            style={{
              margin: "28px 0 0",
              color: GOLD_PALE,
              fontSize: 47,
              fontWeight: 820,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            ₹1,000 credited to cash wallet
          </p>
          <p
            style={{
              margin: "21px 0 0",
              maxWidth: 810,
              color: MUTED,
              fontSize: 27,
              lineHeight: 1.52,
            }}
          >
            Your cash remains withdrawable. The separate reward unlocks after
            qualifying play.
          </p>
        </div>

        <div
          style={{
            marginTop: 62,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 34,
            border: "1px solid rgba(244,194,74,.22)",
            borderRadius: 34,
            padding: 40,
            background: PANEL,
            boxShadow: "0 28px 80px rgba(0,0,0,.3)",
          }}
        >
          <Stat label="Pending reward" value="₹500" accent={GOLD} />
          <Stat label="Qualifying-play target" value="₹2,400" />
          <Stat label="Terms accepted" value="Version 1.0" />
          <Stat label="Reward deadline" value="06 Sep · 18:30 IST" />
        </div>

        <div
          style={{
            marginTop: 26,
            color: MUTED,
            fontSize: 20,
            lineHeight: 1.45,
          }}
        >
          Demo receipt · Server-confirmed state · Cash is not locked
        </div>
      </div>
    </AbsoluteFill>
  );
}

function MissionProgress() {
  const frame = useCurrentFrame();
  const enter = clamp(frame, [0, 22], [0, 1], EASE_OUT);
  const progress = clamp(frame, [18, 112], [0, 100], Easing.bezier(0.45, 0, 0.55, 1));
  const settled = Math.round(2400 * (progress / 100));
  const remaining = Math.max(0, 2400 - settled);
  const completionDim = clamp(frame, [112, 130], [0, 1], Easing.inOut(Easing.cubic));

  return (
    <AbsoluteFill
      style={{
        padding: "152px 72px 72px",
        opacity: enter * (1 - completionDim),
        transform: `translateY(${(1 - enter) * 42}px)`,
      }}
    >
      <div
        style={{
          position: "relative",
          width: 640,
          height: 700,
          margin: "14px auto 0",
          display: "grid",
          placeItems: "center",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: 620,
            height: 620,
            borderRadius: "50%",
            background: `conic-gradient(${GOLD} ${progress * 3.6}deg, rgba(244,194,74,.11) 0deg)`,
            boxShadow: "0 0 80px rgba(244,194,74,.12)",
          }}
        />
        <div
          style={{
            position: "absolute",
            width: 586,
            height: 586,
            borderRadius: "50%",
            background: MIDNIGHT,
          }}
        />
        <Img
          src={staticFile("promo/reward-vault.webp")}
          style={{
            position: "relative",
            width: 530,
            height: 640,
            borderRadius: 286,
            objectFit: "cover",
            objectPosition: "50% 46%",
            opacity: 0.94,
            transform: `scale(${0.93 + enter * 0.07})`,
            filter: "drop-shadow(0 28px 54px rgba(0,0,0,.5))",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: 38,
            border: "1px solid rgba(255,255,255,.16)",
            borderRadius: 999,
            padding: "14px 24px",
            background: "rgba(5,8,14,.86)",
            color: GOLD_PALE,
            fontSize: 23,
            fontWeight: 850,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {Math.round(progress)}% verified
        </div>
      </div>

      <div style={{ marginTop: -8 }}>
        <StatusPill>Wager mission active</StatusPill>
        <h1
          style={{
            margin: "28px 0 0",
            fontSize: 70,
            lineHeight: 1,
            letterSpacing: "-.045em",
          }}
        >
          Unlock your ₹500 reward
        </h1>
        <div
          style={{
            marginTop: 28,
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 28,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <div style={{ color: TEXT, fontSize: 43, fontWeight: 850 }}>
            {rupees(settled)} <span style={{ color: MUTED, fontSize: 27 }}>of ₹2,400</span>
          </div>
          <div style={{ color: GOLD, fontSize: 36, fontWeight: 900 }}>
            {Math.round(progress)}%
          </div>
        </div>
        <div
          style={{
            height: 22,
            marginTop: 20,
            overflow: "hidden",
            border: "1px solid rgba(255,255,255,.1)",
            borderRadius: 999,
            background: "rgba(255,255,255,.07)",
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: "100%",
              borderRadius: 999,
              background: `linear-gradient(90deg, #C78A24, ${GOLD}, #FFF0B2)`,
              boxShadow: "0 0 24px rgba(244,194,74,.42)",
            }}
          />
        </div>
        <div
          style={{
            marginTop: 34,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 18,
          }}
        >
          <div
            style={{
              border: "1px solid rgba(255,255,255,.1)",
              borderRadius: 26,
              padding: 27,
              background: PANEL,
            }}
          >
            <Stat label="Remaining" value={rupees(remaining)} />
          </div>
          <div
            style={{
              border: "1px solid rgba(255,255,255,.1)",
              borderRadius: 26,
              padding: 27,
              background: PANEL,
            }}
          >
            <Stat label="Time remaining" value="3d 12h" />
          </div>
        </div>
        <div
          style={{
            marginTop: 24,
            display: "flex",
            justifyContent: "space-between",
            color: MUTED,
            fontSize: 20,
          }}
        >
          <span>Settled qualifying play only</span>
          <span>Deadline · 06 Sep 2026, 18:30 IST</span>
        </div>
      </div>
    </AbsoluteFill>
  );
}

function Completion() {
  const frame = useCurrentFrame();
  const enter = clamp(frame, [0, 22], [0, 1], EASE_OUT);
  const sweep = clamp(frame, [0, 36], [0, 1], Easing.inOut(Easing.cubic));
  const buttonEnter = clamp(frame, [14, 34], [0, 1], EASE_OUT);

  return (
    <AbsoluteFill
      style={{
        padding: "176px 72px 88px",
        background: `rgba(4, 9, 13, ${0.32 + enter * 0.5})`,
        opacity: enter,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 440,
          width: 1050,
          height: 1050,
          borderRadius: "50%",
          opacity: sweep * 0.4,
          transform: `translate(-50%, -50%) scale(${0.35 + sweep * 0.65})`,
          background:
            "radial-gradient(circle, rgba(36,201,138,.48), rgba(244,194,74,.15) 39%, transparent 70%)",
          filter: "blur(12px)",
        }}
      />
      <div
        style={{
          position: "relative",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          transform: `translateY(${(1 - enter) * 36}px)`,
        }}
      >
        <Img
          src={staticFile("promo/reward-vault.webp")}
          style={{
            width: 510,
            height: 610,
            borderRadius: 280,
            objectFit: "cover",
            objectPosition: "50% 46%",
            filter: "drop-shadow(0 28px 80px rgba(36,201,138,.3))",
            transform: `scale(${0.9 + enter * 0.1})`,
          }}
        />
        <div style={{ marginTop: -26 }}>
          <StatusPill color={EMERALD}>Server confirmed · 100%</StatusPill>
        </div>
        <h1
          style={{
            margin: "28px 0 0",
            color: TEXT,
            fontSize: 82,
            lineHeight: 0.98,
            letterSpacing: "-.055em",
          }}
        >
          Requirement complete
        </h1>
        <p
          style={{
            margin: "25px 0 0",
            color: MUTED,
            fontSize: 28,
            lineHeight: 1.5,
          }}
        >
          ₹2,400 qualifying play verified. Your pending reward is ready.
        </p>
        <div
          style={{
            width: "100%",
            marginTop: 42,
            border: `1px solid ${EMERALD}55`,
            borderRadius: 32,
            padding: "34px 38px",
            background: "rgba(13, 39, 34, .72)",
            boxShadow: "0 30px 90px rgba(0,0,0,.32)",
          }}
        >
          <div style={{ color: MUTED, fontSize: 23, fontWeight: 700 }}>
            Reward ready to claim
          </div>
          <div
            style={{
              marginTop: 7,
              color: EMERALD,
              fontSize: 66,
              fontWeight: 900,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            ₹500
          </div>
        </div>
        <div
          style={{
            width: "100%",
            marginTop: 24,
            borderRadius: 28,
            padding: "27px 32px",
            color: "#05110C",
            background: EMERALD,
            fontSize: 31,
            fontWeight: 900,
            opacity: buttonEnter,
            transform: `translateY(${(1 - buttonEnter) * 18}px)`,
            boxShadow: "0 18px 52px rgba(36,201,138,.24)",
          }}
        >
          Claim ₹500 reward
        </div>
        <div style={{ marginTop: 24, color: MUTED, fontSize: 19 }}>
          Demo state · Claim remains idempotent and server-authoritative
        </div>
      </div>
    </AbsoluteFill>
  );
}

export function WagerMissionPreview() {
  return (
    <AbsoluteFill
      style={{
        background: MIDNIGHT,
        color: TEXT,
        fontFamily: "Manrope, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <Sequence durationInFrames={210} premountFor={FPS}>
        <Shell />
      </Sequence>
      <Sequence from={0} durationInFrames={72} premountFor={FPS}>
        <PaymentReceipt />
      </Sequence>
      <Sequence from={42} durationInFrames={150} premountFor={FPS}>
        <MissionProgress />
      </Sequence>
      <Sequence from={153} durationInFrames={57} premountFor={FPS}>
        <Completion />
      </Sequence>
    </AbsoluteFill>
  );
}
