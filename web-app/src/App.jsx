import { useEffect } from 'react';
import { useChat } from './hooks/useChat';
import ChatHeader from './components/ChatHeader';
import ChatBody from './components/ChatBody';
import ChatComposer from './components/ChatComposer';
import ChargerPicker from './components/ChargerPicker';
import QuickReplies from './components/QuickReplies';
import IdleWarning from './components/IdleWarning';
import ReviewPanel from './components/ReviewPanel';
import AppStorePrompt from './components/AppStorePrompt';
import { MCB_NORMAL, MCB_BURNT } from './assets/mcbImages.js';

export default function App() {
  const {
    messages, typing, closed,
    chargerOptions, showIssueTypes, inputHint, isSpinApp,
    idleWarning, showReview, showYesNo, showMcbImages,
    hasPreviousChat, showAppStore,
    startSession, sendMessage, stayActive, closeFromIdle, submitReview,
    resumeChat, startFresh, dismissAppStore,
  } = useChat();

  useEffect(() => { startSession(); }, []);

  // Show initial category quick replies on the very first bot message, before user replies.
  // For Spin App users whose serial is already known, skip quick replies — the LLM will
  // jump straight to asking what the issue is with that specific charger.
  const spinAppHasSerial = new URLSearchParams(window.location.search).getAll('serial').some(Boolean);
  const showQuickReplies =
    !typing &&
    !closed &&
    !hasPreviousChat &&
    (
      (messages.length === 1 && messages[0]?.role === 'bot' && !(isSpinApp && spinAppHasSerial)) ||
      showIssueTypes
    );

  return (
    <div className="chat-window">
      <ChatHeader onRestart={startSession} />
      <ChatBody messages={messages} typing={typing} />

      {showQuickReplies && <QuickReplies onSelect={sendMessage} />}
      {showMcbImages && !typing && !closed && (
        <div className="mcb-images">
          <div className="mcb-image-card">
            <img src={MCB_NORMAL} alt="Normal MCB" />
            <span>Normal MCB</span>
          </div>
          <div className="mcb-image-card">
            <img src={MCB_BURNT} alt="Burnt MCB" />
            <span>Burnt MCB</span>
          </div>
        </div>
      )}
      {showYesNo && !typing && !closed && (
        <div className="quick-replies">
          <button className="quick-reply-btn" onClick={() => sendMessage('Yes')}>Yes</button>
          <button className="quick-reply-btn" onClick={() => sendMessage('No')}>No</button>
        </div>
      )}
      {chargerOptions.length > 0 && !typing && !closed && (
        <ChargerPicker
          options={chargerOptions}
          onSelect={(idx) => sendMessage(String(idx))}
        />
      )}

      {/* Previous-chat choice buttons — shown before user picks Continue or Start New */}
      {hasPreviousChat && !closed && (
        <div className="quick-replies">
          <button className="quick-reply-btn" onClick={resumeChat}>Continue previous chat</button>
          <button className="quick-reply-btn" onClick={startFresh}>Start new</button>
        </div>
      )}

      {/* Bottom area: review > app store prompt > closed banner > composer */}
      {closed && showReview ? (
        <ReviewPanel onSubmit={submitReview} onRestart={startSession} />
      ) : closed && showAppStore ? (
        <AppStorePrompt onDismiss={dismissAppStore} onRestart={startSession} />
      ) : closed ? (
        <div className="session-closed">
          Session ended.{' '}
          <button onClick={startSession}>Start a new chat</button>
        </div>
      ) : (
        <ChatComposer onSend={sendMessage} disabled={typing || closed || showQuickReplies || hasPreviousChat} inputHint={inputHint} />
      )}

      {/* Idle warning overlay — sits above the composer */}
      {idleWarning && !closed && (
        <IdleWarning onStay={stayActive} onClose={closeFromIdle} />
      )}

      <div className="chat-footer">POWERED BY <span>exicom</span></div>
    </div>
  );
}
