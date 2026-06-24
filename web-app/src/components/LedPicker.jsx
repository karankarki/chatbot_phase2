import { useEffect, useRef } from 'react';
import lottie from 'lottie-web';

import greenBlink  from '../assets/led/old/Green-blink.json';
import whiteBlink  from '../assets/led/old/White-blink.json';
import whiteFlash  from '../assets/led/old/White-flash.json';
import cyanBlink   from '../assets/led/old/cyan-blink.json';
import pinkBlink   from '../assets/led/old/pink-blink.json';
import redBlink    from '../assets/led/old/red-blink.json';
import yellowBlink from '../assets/led/old/yellow-blink.json';
import amberFlash      from '../assets/led/new/Amber-3X rapid flash.json';
import amberSlowBlink  from '../assets/led/new/Amberslowblink.json';
import greenFlashSolid from '../assets/led/new/Green-3Xflash then solid.json';
import redSlowBlink    from '../assets/led/new/Redslowblink.json';
import newWhiteBlink   from '../assets/led/new/Whiteblink.json';
import blueBlink       from '../assets/led/new/blueblink.json';
import blueSlowBlink   from '../assets/led/new/blueslowblink.json';
import purpleSlowBlink from '../assets/led/new/purpleslowblink.json';
import redRapidBlink   from '../assets/led/new/red-rapid blink.json';

const OLD_LEDS = [
  { color: '#26C6DA',      label: 'Cyan',   sub: 'Solid',    message: 'Cyan, solid' },
  { animData: cyanBlink,   label: 'Cyan',   sub: 'Blinking', message: 'Cyan, blinking' },
  { color: '#66BB6A',      label: 'Green',  sub: 'Solid',    message: 'Green, solid' },
  { animData: greenBlink,  label: 'Green',  sub: 'Blinking', message: 'Green, blinking' },
  { color: '#FFA726',      label: 'Yellow', sub: 'Solid',    message: 'Yellow, solid' },
  { animData: yellowBlink, label: 'Yellow', sub: 'Blinking', message: 'Yellow, blinking' },
  { color: '#EF5350',      label: 'Red',    sub: 'Solid',    message: 'Red, solid' },
  { animData: redBlink,    label: 'Red',    sub: 'Blinking', message: 'Red, blinking' },
  { animData: whiteFlash,  label: 'White',  sub: 'Blinking', message: 'White, blinking' },
  { animData: whiteBlink,  label: 'White',  sub: 'Blinking', message: 'White, blinking' },
  { animData: pinkBlink,   label: 'Pink',   sub: 'Blinking', message: 'Pink, blinking' },
];

const NEW_LEDS = [
  { color: '#66BB6A',          label: 'Green',  sub: 'Solid',              message: 'Green, solid' },
  { animData: newWhiteBlink,   label: 'White',  sub: 'Blinking',           message: 'White, blinking' },
  { color: '#42A5F5',          label: 'Blue',   sub: 'Solid',              message: 'Blue, solid' },
  { animData: blueBlink,       label: 'Blue',   sub: 'Blinking',           message: 'Blue, blinking' },
  { animData: blueSlowBlink,   label: 'Blue',   sub: 'Slow Blinking',      message: 'Blue, slow blinking' },
  { animData: greenFlashSolid, label: 'Green',  sub: '3× Blink → Solid',   message: 'Green, 3 blinks then solid' },
  { animData: purpleSlowBlink, label: 'Purple', sub: 'Slow Blinking',      message: 'Purple, slow blinking' },
  { animData: amberFlash,      label: 'Amber',  sub: '3× Rapid Blinking',  message: 'Amber, 3x rapid blinking' },
  { animData: amberSlowBlink,  label: 'Amber',  sub: 'Slow Blinking',      message: 'Amber, slow blinking' },
  { animData: redRapidBlink,   label: 'Red',    sub: 'Rapid Blinking',     message: 'Red, rapid blinking' },
  { animData: redSlowBlink,    label: 'Red',    sub: 'Slow Blinking',      message: 'Red, slow blinking' },
  { color: '#EF5350',          label: 'Red',    sub: 'Solid',              message: 'Red, solid' },
];

function LedButton({ animData, color, label, sub, onClick }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!animData || !containerRef.current) return;
    const anim = lottie.loadAnimation({
      container: containerRef.current,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: animData,
    });
    return () => anim.destroy();
  }, [animData]);

  return (
    <button className="led-btn" onClick={onClick} type="button">
      {animData
        ? <div ref={containerRef} className="led-btn__anim" />
        : <div className="led-btn__solid" style={{ background: color }} />
      }
      <span className="led-btn__label">{label}</span>
      <span className="led-btn__sub">{sub}</span>
    </button>
  );
}

export default function LedPicker({ model, onSelect }) {
  const leds = model === 'new' ? NEW_LEDS : OLD_LEDS;

  return (
    <div className="led-picker">
      <p className="led-picker__hint">Tap the LED pattern you see on your charger:</p>
      <div className="led-picker__grid">
        {leds.map((led, i) => (
          <LedButton
            key={i}
            animData={led.animData}
            color={led.color}
            label={led.label}
            sub={led.sub}
            onClick={() => onSelect(led.message)}
          />
        ))}
      </div>
    </div>
  );
}
