import styles from "./IdentitySetup.module.css";

export function OnboardingWordmark() {
  return (
    <span className={styles.logoLayers} role="img" aria-label="Gram">
      <svg width="100%" viewBox="0 0 777 326" aria-hidden="true">
        <text
          x="388"
          y="255"
          textAnchor="middle"
          fill="currentColor"
          fontSize="255"
          fontWeight="750"
          fontFamily="inherit"
          letterSpacing="-16"
        >
          Gram
        </text>
      </svg>
    </span>
  );
}
