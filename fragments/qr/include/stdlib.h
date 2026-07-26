/* Freestanding shim: qrcodegen never allocates; nothing is needed here. */
#ifndef DER_SHIM_STDLIB_H
#define DER_SHIM_STDLIB_H
#endif
static inline int abs(int value) { return value < 0 ? -value : value; }
static inline long labs(long value) { return value < 0 ? -value : value; }
