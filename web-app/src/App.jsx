import { useEffect } from 'react';
import { useChat } from './hooks/useChat';
import ChatHeader from './components/ChatHeader';
import ChatBody from './components/ChatBody';
import ChatComposer from './components/ChatComposer';
import ChargerPicker from './components/ChargerPicker';
import QuickReplies from './components/QuickReplies';

export default function App() {
  const { messages, typing, closed, chargerOptions, showIssueTypes, inputHint, isSpinApp, startSession, sendMessage } = useChat();

  useEffect(() => { startSession(); }, []);

  const inputLimit = inputHint === 'mobile' ? 10 : inputHint === 'serial' ? 15 : null;

  // Show initial category quick replies on the very first bot message, before user replies.
  // For Spin App users whose serial is already known, skip quick replies — the LLM will
  // jump straight to asking what the issue is with that specific charger.
  const spinAppHasSerial = new URLSearchParams(window.location.search).getAll('serial').some(Boolean);
  const showQuickReplies =
    !typing &&
    !closed &&
    (
      (messages.length === 1 && messages[0]?.role === 'bot' && !(isSpinApp && spinAppHasSerial)) ||
      showIssueTypes
    );

  return (
    <div className="chat-window">
      <ChatHeader onRestart={startSession} />
      <ChatBody messages={messages} typing={typing} />
      {showQuickReplies && <QuickReplies onSelect={sendMessage} />}
      {chargerOptions.length > 0 && !typing && !closed && (
        <ChargerPicker
          options={chargerOptions}
          onSelect={(idx) => sendMessage(String(idx))}
        />
      )}
      {closed ? (
        <div className="session-closed">
          Session ended.{' '}
          <button onClick={startSession}>Start a new chat</button>
        </div>
      ) : (
        <ChatComposer onSend={sendMessage} disabled={typing || closed} maxLength={inputLimit} />
      )}
      <div className="chat-footer">POWERED BY <span>exicom</span></div>
    </div>
  );
}
