// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/*
 * A stand-in for libepoxy's <epoxy/gl.h> for virglrenderer built with
 * emscripten: no dispatch tables, the GL calls go straight to emscripten's
 * WebGL2 bindings (libwebgl.js). The GLES 3.2 and extension headers give
 * the GLES names, GL/glext.h the desktop enums and prototypes that
 * virglrenderer names in code paths it takes only on a desktop GL host.
 * A desktop or GLES 3.1+ function that emscripten does not implement is
 * made from WebGL2 by kw_gl.js where it can be, else resolved by
 * kw_gl_missing.c (generated), which logs the first call.
 */
#ifndef KW_EPOXY_GL_H
#define KW_EPOXY_GL_H

#include <stdbool.h>

#ifndef GL_GLEXT_PROTOTYPES
#define GL_GLEXT_PROTOTYPES 1
#endif
#include <GLES3/gl32.h>
#include <GLES2/gl2ext.h>

#include <GL/gl.h>
#include <GL/glext.h>

/* Entry points that are another name for one emscripten binds, same
 * signature and meaning (libepoxy resolves such aliases at run time). */
#define glBindBufferARB glBindBuffer
#define glGenBuffersARB glGenBuffers
#define glDepthRangefOES glDepthRangef
#define glClipControl glClipControlEXT
#define glGetQueryObjecti64v glGetQueryObjecti64vEXT
#define glGetQueryObjectui64v glGetQueryObjectui64vEXT
#define glQueryCounter glQueryCounterEXT

/* WebGL's buffer types: kw_gl.js gives an element array buffer a twin. */
#define glBindBuffer kw_glBindBuffer
#define glBufferData kw_glBufferData
#define glBufferSubData kw_glBufferSubData
#define glGetBufferSubData kw_glGetBufferSubData
#define glCopyBufferSubData kw_glCopyBufferSubData
#define glDeleteBuffers kw_glDeleteBuffers
#define glDrawElements kw_glDrawElements
#define glDrawElementsInstancedARB kw_glDrawElementsInstanced
#define glDrawElementsInstanced kw_glDrawElementsInstanced
#define glDrawRangeElements kw_glDrawRangeElements
#define glEndTransformFeedback kw_glEndTransformFeedback
#define glPauseTransformFeedback kw_glPauseTransformFeedback

/* WebGL's uniform buffer sizes: kw_gl.js pads buffers and uniform buffer
 * ranges to 16 bytes. */
#define glBindBufferRange kw_glBindBufferRange

/* GL_RENDERER: the WebGL implementation's own name (kw_gl.js), which vrend
 * forwards to the guest ("virgl (...)") in place of "WebKit WebGL". */
#define glGetString kw_glGetString

#ifdef __cplusplus
extern "C" {
#endif

void kw_glBindBuffer(GLenum target, GLuint buffer);
void kw_glBufferData(GLenum target, GLsizeiptr size, const void *data, GLenum usage);
void kw_glBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, const void *data);
void kw_glGetBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, void *data);
void kw_glCopyBufferSubData(GLenum readTarget, GLenum writeTarget, GLintptr readOffset,
                            GLintptr writeOffset, GLsizeiptr size);
void kw_glDeleteBuffers(GLsizei n, const GLuint *buffers);
void kw_glDrawElements(GLenum mode, GLsizei count, GLenum type, const void *indices);
void kw_glDrawElementsInstanced(GLenum mode, GLsizei count, GLenum type, const void *indices,
                                GLsizei instancecount);
void kw_glDrawRangeElements(GLenum mode, GLuint start, GLuint end, GLsizei count, GLenum type,
                            const void *indices);
void kw_glEndTransformFeedback(void);
void kw_glPauseTransformFeedback(void);
void kw_glBindBufferRange(GLenum target, GLuint index, GLuint buffer, GLintptr offset,
                          GLsizeiptr size);
const GLubyte *kw_glGetString(GLenum name);

bool epoxy_has_gl_extension(const char *extension);
bool epoxy_is_desktop_gl(void);
int epoxy_gl_version(void);
int epoxy_glsl_version(void);

#ifdef __cplusplus
}
#endif

#endif
