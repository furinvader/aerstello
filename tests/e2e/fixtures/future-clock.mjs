const NativeDate = Date;
const nativeNow = NativeDate.now.bind(NativeDate);
const offsetMs = Number(process.env.SKY_BAR_TEST_CLOCK_OFFSET_MS ?? 60 * 60 * 1000);

globalThis.Date = class extends NativeDate {
  constructor(...args) {
    super(...(args.length ? args : [nativeNow() + offsetMs]));
  }

  static now() {
    return nativeNow() + offsetMs;
  }
};
