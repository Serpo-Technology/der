/* Freestanding shim: the implementations live in src/part.c. */
#ifndef DER_SHIM_STRING_H
#define DER_SHIM_STRING_H
#include <stddef.h>
void *memcpy(void *dst, const void *src, size_t n);
void *memset(void *dst, int value, size_t n);
void *memmove(void *dst, const void *src, size_t n);
size_t strlen(const char *s);
#endif
static inline char *strchr(const char *s, int wanted) {
  while (*s) {
    if (*s == (char)wanted) return (char *)s;
    s++;
  }
  return (char)wanted == 0 ? (char *)s : 0;
}
