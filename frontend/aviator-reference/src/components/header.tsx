import React from "react";

import logo from "../assets/images/logo.svg";
import refound from "../assets/images/refund.png";
import "../index.scss";
import Context from "../context";
import { getSoundSnapshot, subscribeSound, toggleSound } from "../sound";

const balanceFormatter = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export default function Header() {
  const { userInfo, GameState, errorBackend } = React.useContext(Context);
  const soundEnabled = React.useSyncExternalStore(subscribeSound, getSoundSnapshot, () => false);

  const [howto, setHowto] = React.useState<'howto' | 'short' | 'more' | ''>("howto");
  const [, setFireSystem] = React.useState(false);

  const returnToLobby = () => {
    window.parent.postMessage(
      { source: "chakri-aviator", type: "exit" },
      window.location.origin,
    );
  };

  const roundStatus = errorBackend
    ? "Reconnecting"
    : GameState === "BET"
      ? "Bets open"
      : GameState === "PLAYING"
        ? "In flight"
        : GameState === "GAMEEND"
          ? "Round ended"
          : "Live game";

  return (
    <header className="site-header" role="banner">
      <div className="site-header__container">
        <div className="brand-lockup">
          <div
            className="logo-container"
            role="button"
            tabIndex={0}
            title="Return to games"
            onClick={returnToLobby}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") returnToLobby();
            }}
          >
            <img src={logo} alt="Aviator" className="logo" />
          </div>
          <div
            className={`round-status ${errorBackend ? "is-offline" : ""}`}
            aria-live="polite"
          >
            <span className="round-status__dot" aria-hidden="true" />
            <span>{roundStatus}</span>
          </div>
        </div>
        <nav className="header-actions" aria-label="Game controls">
          {userInfo.userType &&
            <button type="button" className="lobby-button" onClick={returnToLobby}>
              <span>Lobby</span>
              <img width={18} src={refound} alt="" aria-hidden="true" />
            </button>
          }
          <button type="button" className="howto" onClick={() => setHowto("short")}>
            <span className="help-logo" aria-hidden="true" />
            <span className="help-msg">How to play</span>
          </button>
          <button
            type="button"
            className={`sound-toggle ${soundEnabled ? "is-on" : ""}`}
            onClick={() => void toggleSound()}
            aria-pressed={soundEnabled}
            aria-label={soundEnabled ? "Mute game sound" : "Enable game sound"}
            title={soundEnabled ? "Sound on" : "Enable sound"}
          >
            <span className="sound-toggle__icon" aria-hidden="true">
              {soundEnabled ? "♪" : "×"}
            </span>
            <span className="sound-toggle__label">{soundEnabled ? "Sound on" : "Sound off"}</span>
          </button>
          <div
            className="balance"
            aria-label={`Balance ${balanceFormatter.format(Number(userInfo.balance) || 0)} chips`}
          >
            <span className="balance__label">Balance</span>
            <div className="balance__value">
              <strong className="amount">
                {balanceFormatter.format(Number(userInfo.balance) || 0)}
              </strong>
              <span className="currency">CHIPS</span>
            </div>
          </div>
        </nav>
      </div>
      {howto === "short" && <div className="modal">
        <button type="button" className="back" aria-label="Close how to play" onClick={() => setHowto("")} />
        <div className="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="how-to-play-title">
          <div className="modal-content">
            <div className="modal-header modal-bg text-uppercase">
              <span id="how-to-play-title">How to Play?</span>
              <button type="button" aria-label="Close how to play" onClick={() => setHowto('')} className="close modal-close">
                <span>×</span>
              </button>
            </div>
            <div className="modal-body m-body-bg">
              <div className="youtube">
                <div className="embed-responsive">
                  <iframe title="Aviator game tutorial" className="embed-responsive-item" src="https://www.youtube.com/embed/PZejs3XDCSY?playsinline=1" allowFullScreen />
                  {/* <iframe className="embed-responsive-item" src="https://www.youtube.com/watch?v=bBeZSuHI4Qc" /> */}
                </div>
              </div>
              <div className="step">
                <div className="bullet">01</div>
                <p>Make a bet, or even two at same time and wait for the round to start.<br />
                  ஒரு பந்தயம் அல்லது ஒரே நேரத்தில் இரண்டு பந்தயம் கட்டலாம் ,  மற்றும் சுற்று தொடங்கும் வரை காத்திருக்கவும்.
                  एक बेट लगाए , या एक साथ 2 बेट लगाए  और खेल शुरू होने का इंतज़ार करें  </p>
              </div>
              <div className="step">
                <div className="bullet bullet-2">02</div>
                <p>Look after the luck plane, Your win is bet multiply by a coefficient of lucky plane
                  Cash out  before plane files away and money is yours! <br />

                  அதிர்ஷ்ட விமானத்தை கவனியுங்கள், விமானம் பறக்கும் உயரம் பொறுத்து உங்கள் பணம் இரட்டிப்பு ஆகும். ( நீங்கள் 100 ரூபாய் பெட் கட்டினால் , விமானம் 2X பறந்தால், உங்களுக்கு 200 ரூபாய் கிடைக்கும்.

                  लकी प्लेन को देखें, आपकी जीती हुई राशि आपकी बेट अमाउंट और प्लेन की उड़ान संख्या का गुणा करके आएगी</p>
              </div>
              <div className="step">
                <div className="bullet bullet-3">03</div>
                <p>Cash out before plane files away and money is yours!<br />
                  விமானம் பறந்து செல்லும் முன்பு பணத்தை கேஷ் அவுட் செயுங்கள். வெற்றி உங்களுடையது!
                  प्लेन क्रेश होने से पहले कैशऑउट करें और अपनी बेट अमाउंट के साथ जीता हुआ अमाउंट भी आपका</p>
              </div>
            </div>
            <div className="modal-footer m-f-bg">
              <button type="button" onClick={() => setHowto("more")}>
                detailed rules
              </button>
            </div>
          </div>
        </div>
      </div>}

      {howto === "more" && <div className="modal">
        <button type="button" className="back" aria-label="Close game rules" onClick={() => setHowto("")} />
        <div className="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="game-rules-title">
          <div className="modal-content">
            <div className="modal-header ">
              <span id="game-rules-title" className="text-uppercase">Game rules</span>
              <button type="button" aria-label="Close game rules" onClick={() => setHowto("")} className="close">
                <span>×</span>
              </button>
            </div>
            <div className="modal-body p-1r">
              <p className="text-gray">
                Aviator is a new generation of iGaming entertainment. You can win many times more, in seconds! Aviator is built on a provably fair system, which is currently the only real guarantee of honesty in the gambling industry.
              </p>
              <button className="under-a" onClick={() => setFireSystem(true)}> Read more about provably fair system </button>
              <h6 className="title-2"> How to play </h6>
              <div className="youtube w-99">
                <div className="embed-responsive">
                  <iframe title="Aviator game tutorial" className="embed-responsive-item" src="https://www.youtube.com/embed/PZejs3XDCSY?playsinline=1" allowFullScreen />
                </div>
              </div>
              <h6 className="pt-5"> Aviator is as easy to play as 1-2-3: </h6>
              <div className="steps-container">
                <div className="step-item">
                  <h3>01</h3>
                  <div className="step-bg-img"></div>
                  <div className="step-text pt-2">
                    <span>bet</span>   before take-off
                  </div>
                </div>
                <div className="step-item">
                  <h3>02</h3>
                  <div className="step-bg-img-2"></div>
                  <div className="step-text">
                    <span>Watch</span> as your Lucky Plane takes off and your winnings increase.
                  </div>
                </div>
                <div className="step-item">
                  <h3>03</h3>
                  <div className="step-bg-img-3"></div>
                  <div className="step-text">
                    <span>Cash out</span>  before the plane disappears and wins X times more!
                  </div>
                </div>
              </div>
              <p className="text-grey mt-20"> But remember, if you did not have time to Cash Out before the Lucky Plane flies away, your bet will be lost. Aviator is pure excitement! Risk and win. It’s all in your hands! </p>
              <div className="rules-list">
                <div className="rules-list-title"> More details</div>
                <ul className="list-group">
                  <li className="list-group-item">
                    The win multiplier starts at 1x and grows more and more as the Lucky Plane takes off.
                  </li>
                  <li className="list-group-item">
                    Your winnings are calculated at the multiplier at which you made a Cash Out, multiplied by your bet.
                  </li>
                  <li className="list-group-item">
                    Before the start of each round, our provably fair random number generator generates the multiplier at which the Lucky Plane will fly away. You can check the honesty of this generation by clicking on  <span className="icon-fair"></span>  icon, opposite the result, in the History tab
                  </li>
                </ul>
              </div>
              <h6> GAME FUNCTIONS </h6>
              <div className="rules-list pt-2">
                <div className="rules-list-title"> Bet & Cash Out </div>
                <ul className="list-group">
                  <li className="list-group-item"> Select an amount and press the “Bet” button to make a bet. </li>
                  <li className="list-group-item"> You can make two bets simultaneously, by adding a second bet panel. To add a second bet panel, press the plus icon, which is located on the top right corner of the first bet panel. </li>
                  <li className="list-group-item"> Press the “Cash Out” button to cash out your winnings. Your win is your bet multiplied by the Cash Out multiplier. </li>
                  <li className="list-group-item"> Your bet is lost, if you didn’t cash out before the plane flies away. </li>
                </ul>
              </div>
              <div className="rules-list pt-2">
                <div className="rules-list-title"> Auto Play & Auto Cash Out </div>
                <ul className="list-group">
                  <li className="list-group-item"> Auto Play is activated from the “Auto” tab on the Bet Panel, by pressing the “Auto Play” button. </li>
                  <li className="list-group-item"> Auto Play can be limited by round count, balance decrease, balance increase, or a single-win target. </li>
                  <li className="list-group-item"> Auto Cash Out is available from the “Auto” tab. After activation, the server settles the wager at the exact multiplier entered if the plane reaches it before flying away. </li>
                </ul>
              </div>
              <div className="rules-list pt-2">
                <div className="rules-list-title"> Live Bets & Statistics </div>
                <ul className="list-group">
                  <li className="list-group-item"> On the left side of the game interface (or under the Bet Panel on mobile), is located the Live Bets panel. Here you can see all bets that are being made in the current round. </li>
                  <li className="list-group-item"> In the “My Bets” panel you can see all of your bets and Cash Out information. </li>
                  <li className="list-group-item"> In the “Top” panel, game statistics are located. You can browse wins by amount, or Cash Out multiplier, and see the biggest round multipliers. </li>
                </ul>
              </div>
              <div className="rules-list pt-2">
                <div className="rules-list-title"> Free bets </div>
                <ul className="list-group">
                  <li className="list-group-item">{" You can check the status of Free Bets, from the Game Menu > Free Bets. Free Bets are awarded by the operator, or by the Rain Feature. "}</li>
                </ul>
              </div>
              <div className="rules-list pt-2">
                <div className="rules-list-title"> Randomisation </div>
                <ul className="list-group">
                  <li className="list-group-item"> The multiplier for each round is generated by a “Provably Fair” algorithm and is completely transparent, and 100% fair. <button className="under-a" onClick={() => setFireSystem(true)}> Read more about provably fair system </button> </li>
                  <li className="list-group-item"> {"You can check and modify the Provably Fair settings from the Game menu > Provably Fair settings."} </li>
                  <li className="list-group-item"> You can check the fairness of each round by pressing <span className="icon-fair"></span> icon, opposite the results in the “My Bets” or inside “Top” tabs. </li>
                </ul>
              </div>
              <div className="rules-list pt-2">
                <div className="rules-list-title"> Other </div>
                <ul className="list-group">
                  <li className="list-group-item"> If the internet connection is interrupted when the bet is active, the game will auto cash out with the current multiplier, and the winning amount will be added to your balance. </li>
                  <li className="list-group-item"> In the event of a malfunction of the gaming hardware/software, all affected game bets and payouts are rendered void and all affected bets are refunded. </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>}
    </header>
  );
}
