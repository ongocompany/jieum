// 버퍼 유틸
export {
  sanitizeHangul,
  extractTrailingHangul,
  mergeTrailingBuffer,
  findTrailingBufferRange,
  type BufferRange,
} from './buffer-utils.js';

// Surface Adapter
export {
  createSurfaceAdapter,
  findEditableTargets,
  type SurfaceAdapter,
} from './surface-adapter.js';

// 후보 팝업
export {
  createPopup,
  type JieumPopup,
  type PopupState,
  type PickResult,
} from './popup.js';

// 컨트롤러
export {
  attachEditableSurface,
  attachAll,
  observeEditableSurfaces,
  type JieumController,
  type ControllerState,
  type AttachOptions,
} from './controller.js';
