// The Worker runtime exposes this workerd extension, while lib.dom's
// SubtleCrypto surface does not. The worker-test project intentionally loads
// both libraries, so merge the runtime method into the DOM declaration.
interface SubtleCrypto {
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean;
}
