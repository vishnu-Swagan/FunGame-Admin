import React from "react";
import Context from "../../context";

export default function History() {
  const { history } = React.useContext(Context);
  const [showHistory, setShowHistory] = React.useState(false);

  return (
    <>
      <section className="history-bar" aria-label="Recent round multipliers">
        <div className="history-label">
          <span className="live-mark"></span>
          Previous rounds
        </div>
        <div className="history-content">
          <div className="history-items-container">
            {history.map((item, key) => {
              const num = Number(item);
              const tier = num < 2 ? 'low' : num <= 10 ? 'mid' : 'high';
              return (
                <span key={`${item}-${key}`} className={`history-item ${tier}`}>
                  {Number(item).toFixed(2)}x
                </span>
              );
            })}
          </div>
        </div>
        <button
          type="button"
          className="history-toggle"
          aria-label="Open round history"
          aria-expanded={showHistory}
          onClick={() => setShowHistory(!showHistory)}
        >
          <i className="fas fa-clock-rotate-left" aria-hidden="true"></i>
        </button>
      </section>

      {showHistory && <button type="button" className="history-backdrop" aria-label="Close round history" onClick={() => setShowHistory(false)}></button>}
      <div className={`history-popup ${showHistory ? 'show' : ''}`} role="dialog" aria-modal="true" aria-hidden={!showHistory} aria-label="Crash history">
        <div className="popup-header">
          <div>
            <strong>Round history</strong>
            <span>{history.length} verified results</span>
          </div>
          <button type="button" className="close-popup" aria-label="Close round history" onClick={() => setShowHistory(false)}>×</button>
        </div>
        <div className="popup-body">
          {history.length === 0 ? (
            <div className="history-empty">Results will appear after the first round.</div>
          ) : (
            history.map((item, key) => {
              const num = Number(item);
              const className = num < 2 ? 'low' : num <= 10 ? 'mid' : 'high';
              return (
                <div key={`${item}-${key}`} className={`popup-item ${className}`}>
                  {Number(item).toFixed(2)}x
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
