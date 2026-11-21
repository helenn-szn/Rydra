'use strict';

const { ValidationCode } = require('@smartspectra/node-sdk/renderer');

// SDK validation codes -> Rydra hint keys (translated in the UI and grouped into light / position / stillness).
const HINTS = {
  [ValidationCode.kOk]: 'ok',
  [ValidationCode.kNoFaceFound]: 'noFace',
  [ValidationCode.kMultipleFacesFound]: 'multipleFaces',
  [ValidationCode.kFaceNotCentered]: 'notCentered',
  [ValidationCode.kFaceTooClose]: 'tooClose',
  [ValidationCode.kFaceTooFar]: 'tooFar',
  [ValidationCode.kFaceTooHigh]: 'tooHigh',
  [ValidationCode.kFaceTooLow]: 'tooLow',
  [ValidationCode.kFaceNotForward]: 'notForward',
  [ValidationCode.kTooDark]: 'tooDark',
  [ValidationCode.kTooBright]: 'tooBright',
  [ValidationCode.kChestNotVisible]: 'chestNotVisible',
  [ValidationCode.kCameraTuning]: 'tuning',
  [ValidationCode.kFrameRateTooLow]: 'lowFps',
  [ValidationCode.kExcessiveMotion]: 'motion',
};

module.exports = { HINTS };
