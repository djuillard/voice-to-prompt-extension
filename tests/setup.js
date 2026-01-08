// Chrome API mocks with both callback and promise support

const mockStorage = {
  _data: {},

  get: jest.fn((keys, callback) => {
    const result = {};
    if (typeof keys === 'string') {
      result[keys] = this._data[keys];
    } else if (Array.isArray(keys)) {
      keys.forEach(key => {
        result[key] = this._data[key];
      });
    } else {
      Object.assign(result, this._data);
    }

    if (callback) {
      callback(result);
    }
    return Promise.resolve(result);
  }),

  set: jest.fn((items, callback) => {
    Object.assign(this._data, items);
    if (callback) {
      callback();
    }
    return Promise.resolve();
  }),

  clear: jest.fn(() => {
    this._data = {};
    return Promise.resolve();
  }),

  reset() {
    this._data = {};
    this.get.mockClear();
    this.set.mockClear();
    this.clear.mockClear();
  }
};

global.chrome = {
  runtime: {
    sendMessage: jest.fn(() => Promise.resolve({ success: true })),
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn()
    },
    getURL: jest.fn((path) => `chrome-extension://test-id/${path}`),
    id: 'test-extension-id'
  },
  storage: {
    sync: { ...mockStorage },
    local: { ...mockStorage }
  },
  tabs: {
    query: jest.fn(() => Promise.resolve([{ id: 1, url: 'https://example.com' }])),
    sendMessage: jest.fn(() => Promise.resolve()),
    create: jest.fn(() => Promise.resolve()),
    get: jest.fn(() => Promise.resolve({ id: 1, url: 'https://example.com' }))
  },
  commands: {
    onCommand: {
      addListener: jest.fn()
    }
  },
  action: {
    setBadgeText: jest.fn(() => Promise.resolve()),
    setBadgeBackgroundColor: jest.fn(() => Promise.resolve()),
    getBadgeText: jest.fn(() => Promise.resolve(''))
  }
};

global.AudioContext = jest.fn(() => ({
  createScriptProcessor: jest.fn(() => ({
    onaudioprocess: null,
    connect: jest.fn(),
    disconnect: jest.fn()
  })),
  createMediaStreamSource: jest.fn(),
  destination: {},
  state: 'running',
  close: jest.fn(() => Promise.resolve())
}));

global.navigator = {
  mediaDevices: {
    getUserMedia: jest.fn(() => Promise.resolve({
      getAudioTracks: jest.fn(() => [{ stop: jest.fn(), getSettings: jest.fn() }]),
      getTracks: jest.fn(() => [])
    }))
  },
  clipboard: {
    writeText: jest.fn(() => Promise.resolve())
  },
  userAgent: 'Mozilla/5.0 Test User Agent'
};

global.window = {
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
  getComputedStyle: jest.fn(() => ({
    visibility: 'visible',
    display: 'block',
    opacity: '1'
  }))
};

global.document = {
  querySelectorAll: jest.fn(() => []),
  querySelector: jest.fn(() => null),
  createElement: jest.fn(() => ({
    appendChild: jest.fn(),
    remove: jest.fn(),
    style: {},
    dispatchEvent: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn()
  })),
  body: {
    appendChild: jest.fn(),
    removeChild: jest.fn()
  },
  activeElement: null,
  addEventListener: jest.fn(),
  removeEventListener: jest.fn()
};

global.getSelection = jest.fn(() => ({
  getRangeAt: jest.fn(() => ({
    deleteContents: jest.fn(),
    insertNode: jest.fn(),
    collapse: jest.fn()
  })),
  removeAllRanges: jest.fn(),
  addRange: jest.fn()
}));

global.lamejs = {
  Mp3Encoder: jest.fn(() => ({
    encodeBuffer: jest.fn(() => new Uint8Array(1024)),
    flush: jest.fn(() => new Uint8Array(512))
  }))
};

beforeEach(() => {
  mockStorage.reset();
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});
