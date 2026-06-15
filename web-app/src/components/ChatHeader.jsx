import icon from '../assets/spinwise-icon.svg';

export default function ChatHeader({ onRestart }) {
  return (
    <div className="chat-header">
      <div className="chat-header__brand">
        <img src={icon} alt="SpinWise" className="chat-header__avatar" />
        <div>
          <div className="chat-header__title">SpinWise</div>
          <div className="chat-header__subtitle">Exicom Virtual Assistant</div>
        </div>
      </div>
      <button className="chat-header__restart" onClick={onRestart} title="Start over">↺</button>
    </div>
  );
}
