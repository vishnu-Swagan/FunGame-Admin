import React from "react";
import Header from "./components/header";
import BetsUsers from "./components/bet-users";
import Main from "./components/Main";
// import { useCrashContext } from "./components/Main/context";
import Context from "./context";
// import "./App.scss";

function App() {
  const { rechargeState, errorBackend } = React.useContext(Context);
  return (
    <div className="main-container">
      {errorBackend && (
        <div className="connection-notice" role="status" aria-live="polite">
          <span aria-hidden="true" />
          Reconnecting to the live round
        </div>
      )}
     
      {rechargeState && (
        <div className="recharge">
          <div className="recharge-body">
            <div className="recharge-body-font">
              Insufficient balance amount
            </div>
            <a href="/chips/deposit" target="_top">
              Request chips
            </a>
          </div>
        </div>
      )}
      <Header />
      <div className="game-container">
        <BetsUsers />
        <Main />
      </div>
    </div>
  );
}

export default App;
