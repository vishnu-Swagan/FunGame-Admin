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
        <div style={{
          position: 'fixed',
          top: '10px',
          right: '10px',
          background: '#ff4444',
          color: 'white',
          padding: '8px 16px',
          borderRadius: '4px',
          zIndex: 9999,
          fontSize: '12px'
        }}>
          ⚠️ Connection to server lost
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
