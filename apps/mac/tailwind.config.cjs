const textStyle = (name) => [
  `var(--${name}-font-size)`,
  {
    lineHeight: `var(--${name}-line-height)`,
    letterSpacing: `var(--${name}-letter-spacing)`,
    fontWeight: `var(--${name}-font-weight)`,
  },
];

/** @type {import("tailwindcss").Config} */
module.exports = {
  content: {
    relative: true,
    files: ["./index.html", "./src/**/*.{ts,tsx}"],
  },
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",
      canvas: "var(--surface-primary)",
      sidebar: "var(--surface-primary)",
      panel: "var(--surface-secondary)",
      raised: "var(--surface-tertiary)",
      hover: "var(--interaction-hover)",
      line: "var(--border-subtle)",
      strong: "var(--border-strong)",
      foreground: "var(--text-primary)",
      secondary: "var(--text-secondary)",
      muted: "var(--text-tertiary)",
      inverse: "var(--text-inverse)",
      selected: "var(--interaction-selected)",
      surface: {
        primary: "var(--surface-primary)",
        secondary: "var(--surface-secondary)",
        tertiary: "var(--surface-tertiary)",
        stroke: "var(--surface-stroke)",
      },
    },
    extend: {
      fontWeight: {
        normal: "var(--font-weight-regular)",
        medium: "var(--font-weight-medium)",
        semibold: "var(--font-weight-semibold)",
      },
      fontFamily: {
        sans: ["Inter Variable", "sans-serif"],
        // Tailwind preflight uses mono for code, pre, kbd, and samp.
        mono: ["Inter Variable", "sans-serif"],
      },
    },
    fontSize: {
      "heading-xs": textStyle("heading-xs"),
      "label-md": textStyle("label-md"),
      "label-sm": textStyle("label-sm"),
      "label-xs": textStyle("label-xs"),
      "label-2xs": textStyle("label-2xs"),
      xs: [
        "var(--body-xs-font-size)",
        {
          lineHeight: "var(--body-xs-line-height)",
          letterSpacing: "var(--body-xs-letter-spacing)",
        },
      ],
      sm: [
        "var(--body-sm-font-size)",
        {
          lineHeight: "var(--body-sm-line-height)",
          letterSpacing: "var(--body-sm-letter-spacing)",
        },
      ],
      base: [
        "var(--body-md-font-size)",
        {
          lineHeight: "var(--body-md-line-height)",
          letterSpacing: "var(--body-md-letter-spacing)",
        },
      ],
      lg: [
        "var(--body-lg-font-size)",
        {
          lineHeight: "var(--body-lg-line-height)",
          letterSpacing: "var(--body-lg-letter-spacing)",
        },
      ],
      xl: [
        "var(--body-xl-font-size)",
        {
          lineHeight: "var(--body-xl-line-height)",
          letterSpacing: "var(--body-xl-letter-spacing)",
        },
      ],
      "2xl": [
        "var(--heading-sm-font-size)",
        {
          lineHeight: "var(--heading-sm-line-height)",
          letterSpacing: "var(--heading-sm-letter-spacing)",
        },
      ],
      "3xl": [
        "var(--heading-md-font-size)",
        {
          lineHeight: "var(--heading-md-line-height)",
          letterSpacing: "var(--heading-md-letter-spacing)",
        },
      ],
      "4xl": [
        "var(--heading-lg-font-size)",
        {
          lineHeight: "var(--heading-lg-line-height)",
          letterSpacing: "var(--heading-lg-letter-spacing)",
        },
      ],
      "heading-lg": [
        "var(--heading-lg-font-size)",
        {
          lineHeight: "var(--heading-lg-line-height)",
          letterSpacing: "var(--heading-lg-letter-spacing)",
          fontWeight: "var(--heading-lg-font-weight)",
        },
      ],
      "heading-md": [
        "var(--heading-md-font-size)",
        {
          lineHeight: "var(--heading-md-line-height)",
          letterSpacing: "var(--heading-md-letter-spacing)",
          fontWeight: "var(--heading-md-font-weight)",
        },
      ],
      "heading-sm": [
        "var(--heading-sm-font-size)",
        {
          lineHeight: "var(--heading-sm-line-height)",
          letterSpacing: "var(--heading-sm-letter-spacing)",
          fontWeight: "var(--heading-sm-font-weight)",
        },
      ],
      "body-xl": [
        "var(--body-xl-font-size)",
        {
          lineHeight: "var(--body-xl-line-height)",
          letterSpacing: "var(--body-xl-letter-spacing)",
          fontWeight: "var(--body-xl-font-weight)",
        },
      ],
      "body-lg": [
        "var(--body-lg-font-size)",
        {
          lineHeight: "var(--body-lg-line-height)",
          letterSpacing: "var(--body-lg-letter-spacing)",
          fontWeight: "var(--body-lg-font-weight)",
        },
      ],
      "body-md": [
        "var(--body-md-font-size)",
        {
          lineHeight: "var(--body-md-line-height)",
          letterSpacing: "var(--body-md-letter-spacing)",
          fontWeight: "var(--body-md-font-weight)",
        },
      ],
      "body-sm": [
        "var(--body-sm-font-size)",
        {
          lineHeight: "var(--body-sm-line-height)",
          letterSpacing: "var(--body-sm-letter-spacing)",
          fontWeight: "var(--body-sm-font-weight)",
        },
      ],
      "body-xs": [
        "var(--body-xs-font-size)",
        {
          lineHeight: "var(--body-xs-line-height)",
          letterSpacing: "var(--body-xs-letter-spacing)",
          fontWeight: "var(--body-xs-font-weight)",
        },
      ],
      "body-2xs": [
        "var(--body-2xs-font-size)",
        {
          lineHeight: "var(--body-2xs-line-height)",
          letterSpacing: "var(--body-2xs-letter-spacing)",
          fontWeight: "var(--body-2xs-font-weight)",
        },
      ],
    },
  },
  plugins: [],
};
