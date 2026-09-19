import { useAppReducedMotion } from '../hooks/useAppReducedMotion';
import { useState } from 'react';
import { motion } from 'motion/react';
import bubbleCatAvatar from '../assets/bubble-cat-avatar.jpg';

/** Bubble's knowledge-base cat avatar, styled as a quiet welcome mark. */
export function NewThreadLogo() {
  const reducedMotion = useAppReducedMotion();
  const [rotations, setRotations] = useState(0);
  const [enlarged, setEnlarged] = useState(false);
  const [greeting, setGreeting] = useState(false);

  return (
    <motion.div
      className="bubble-new-thread-logo no-drag"
      aria-hidden="true"
      animate={{ rotate: -rotations * 360, scale: enlarged && !reducedMotion ? 1.18 : 1 }}
      transition={reducedMotion ? { duration: 0 } : { type: 'spring', duration: 0.55, bounce: 0.15 }}
      onAnimationComplete={() => setEnlarged(false)}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch' && !reducedMotion) setGreeting(true);
      }}
      onPointerUp={(event) => {
        if (event.button !== 0 || reducedMotion) return;
        setRotations((value) => value + 1);
        setEnlarged(true);
      }}
    >
      <motion.img
        src={bubbleCatAvatar}
        alt=""
        width={64}
        height={64}
        draggable={false}
        animate={greeting && !reducedMotion ? { rotate: [0, -8, 6, -3, 0] } : { rotate: 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.6, ease: 'easeInOut' }}
        onAnimationComplete={() => setGreeting(false)}
      />
    </motion.div>
  );
}
