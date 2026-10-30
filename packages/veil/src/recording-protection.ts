/** Privacy rules applied before browser events leave the recording context. */
export const recordingProtectionOptions = {
  maskAllInputs: true,
  maskTextSelector:
    '[data-scry-protected], [data-private], [aria-label*="secret" i], [aria-label*="password" i]',
  blockSelector: "img,image,svg,video,audio,canvas,object,embed,picture,iframe",
  recordCanvas: false,
  collectFonts: false,
  recordCrossOriginIframes: false,
  slimDOMOptions: {
    script: true,
    comment: true,
    headFavicon: true,
    headWhitespace: true,
    headMetaDescKeywords: true,
    headMetaSocial: true,
    headMetaRobots: true,
    headMetaHttpEquiv: true,
    headMetaAuthorship: true,
    headMetaVerification: true,
  },
} as const;
