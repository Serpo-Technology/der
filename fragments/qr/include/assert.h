/* Freestanding shim: asserts compile out (the guest returns errors through
 * the envelope; a trapped instance would be a bug in the part). */
#ifndef DER_SHIM_ASSERT_H
#define DER_SHIM_ASSERT_H
#define assert(condition) ((void)0)
#endif
