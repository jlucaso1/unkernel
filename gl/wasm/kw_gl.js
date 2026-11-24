// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// GL entry points that virglrenderer calls and emscripten does not bind (or
// binds too narrowly for it), made from what WebGL2 has (--js-library in
// build.sh). The rest of the gap is stubbed by gl-missing.txt.
//
//   buffer types      WebGL types a buffer by its first binding: one bound to
//                     ELEMENT_ARRAY_BUFFER can never be bound to another
//                     target but the copy targets, nor the other way round,
//                     and data cannot be copied between the two kinds on the
//                     GPU. Mesa's virgl driver streams vertices and indices
//                     through the same buffers. So the buffers vrend names are
//                     never element buffers: binding one to
//                     ELEMENT_ARRAY_BUFFER binds its element twin instead (a
//                     second buffer, made on first use); data calls on that
//                     target go to the buffer itself through a copy target and,
//                     when they bring the data, to the twin as well; a write on
//                     the GPU (buffer copy, transform feedback) marks the twin
//                     stale, and an indexed draw reloads a stale twin by
//                     reading the buffer back. vrend's calls reach these
//                     through the kw_ names (epoxy/gl.h).
//   uniform sizes     WebGL refuses a draw whose uniform buffer range is
//                     smaller than the block it backs (UNIFORM_BLOCK_DATA_SIZE,
//                     GL_INVALID_OPERATION "a uniform buffer that is too
//                     small"), which desktop drivers let pass, and vrend binds
//                     the guest's range as it is. An std140 block's size is a
//                     multiple of 16, so a range short of only its trailing
//                     padding is a common bug (SuperTuxKart 1.4's Matrices
//                     block: 592 bytes, its buffer 584): a uniform buffer range
//                     is rounded up to 16 bytes, and every buffer vrend
//                     allocates (no data) to 16 bytes so that the range fits
//                     (offsets are aligned to UNIFORM_BUFFER_OFFSET_ALIGNMENT,
//                     a multiple of 16).
//   buffer maps       glMapBufferRange, glUnmapBuffer, glFlushMappedBufferRange:
//                     WebGL has no buffer mapping. A map is a copy in module
//                     memory, filled by getBufferSubData when the range must be
//                     read or kept, written back by bufferSubData at unmap (or
//                     at each flush, with GL_MAP_FLUSH_EXPLICIT_BIT).
//   indexed blend     glEnableIndexedEXT and the rest: OES_draw_buffers_indexed
//                     (its GLES names are what vrend's feature checks find).
//   base vertex       glDraw*BaseVertex*, glDraw*BaseInstance:
//                     WEBGL_draw_instanced_base_vertex_base_instance when the
//                     browser has it (a draft extension; Chromium hides it
//                     without --enable-webgl-draft-extensions), else every
//                     enabled array attribute is pointed BASE elements further
//                     for the draw (base vertex for per-vertex attributes,
//                     base instance for instanced ones) and put back after.
//   framebuffers      glFramebufferTexture3D(OES): framebufferTextureLayer.
//   queries           glGetQueryObjectiv (WebGL2's getQueryParameter).
//   renderer name     glGetString(GL_RENDERER): WebGL answers "WebKit WebGL";
//                     the unmasked name (WEBGL_debug_renderer_info) when the
//                     browser gives it, so the guest's "virgl (...)" names
//                     the WebGL implementation.

addToLibrary({
  $kwgl: {
    ELEMENT: 0x8893, COPY_READ: 0x8F36, COPY_WRITE: 0x8F37,
    maps: {}, // target -> the mapped range: { ptr, offset, length, access }
    twins: {}, // buffer name -> its element twin (a WebGLBuffer: .kwOrig, .kwStale)
    ntwins: 0,
    stale: 0, // twins marked stale
    said: {},
    once(what) {
      if (kwgl.said[what]) return;
      kwgl.said[what] = 1;
      err(`kw_gl: ${what}`);
    },
    ext(name) {
      const cache = (GLctx.kwExt ??= {});
      if (!(name in cache)) cache[name] = GLctx.getExtension(name);
      return cache[name];
    },
    binding(target) {
      switch (target) {
        case 0x8892: return 0x8894; // ARRAY_BUFFER
        case 0x8893: return 0x8895; // ELEMENT_ARRAY_BUFFER
        case 0x8F36: return 0x8F36; // COPY_READ_BUFFER (its own binding enum)
        case 0x8F37: return 0x8F37; // COPY_WRITE_BUFFER
        case 0x88EB: return 0x88ED; // PIXEL_PACK_BUFFER
        case 0x88EC: return 0x88EF; // PIXEL_UNPACK_BUFFER
        case 0x8A11: return 0x8A28; // UNIFORM_BUFFER
        case 0x8C8E: return 0x8C8F; // TRANSFORM_FEEDBACK_BUFFER
      }
      return 0;
    },
    // The buffer vrend has bound to TARGET (for ELEMENT_ARRAY_BUFFER: the
    // buffer whose twin is bound), or null.
    bound(target) {
      const b = GLctx.getParameter(kwgl.binding(target));
      return b && b.kwOrig ? GL.buffers[b.kwOrig] : b;
    },
    // What a data call on TARGET reaches: { buf, twin }, vrend's buffer and
    // its element twin if it has one.
    reach(target) {
      if (target === kwgl.ELEMENT) {
        const t = GLctx.getParameter(0x8895);
        return t && t.kwOrig ? { buf: GL.buffers[t.kwOrig], twin: t } : { buf: t, twin: null };
      }
      const e = kwgl.ntwins && kwgl.binding(target);
      const b = e ? GLctx.getParameter(e) : null;
      return { buf: b, twin: b ? kwgl.twins[b.name] : null };
    },
    // Run FN with BUF bound to the copy target TARGET, then put that back.
    withCopy(target, buf, fn) {
      const old = GLctx.getParameter(target);
      GLctx.bindBuffer(target, buf);
      try {
        return fn();
      } finally {
        GLctx.bindBuffer(target, old);
      }
    },
    setStale(twin, stale) {
      if (!twin || !!twin.kwStale === stale) return;
      twin.kwStale = stale;
      kwgl.stale += stale ? 1 : -1;
    },
    // Load TWIN from its buffer, by reading that back.
    reload(twin) {
      const bytes = kwgl.withCopy(kwgl.COPY_READ, GL.buffers[twin.kwOrig], () => {
        const n = GLctx.getBufferParameter(kwgl.COPY_READ, 0x8764 /* BUFFER_SIZE */);
        const b = new Uint8Array(n);
        if (n) GLctx.getBufferSubData(kwgl.COPY_READ, 0, b);
        return b;
      });
      kwgl.withCopy(kwgl.COPY_WRITE, twin, () => GLctx.bufferData(kwgl.COPY_WRITE, bytes, 0x88E8 /* DYNAMIC_DRAW */));
      kwgl.setStale(twin, false);
    },
    // The element buffer now bound: reload it if the GPU changed its buffer.
    syncElements() {
      if (!kwgl.stale) return;
      const twin = GLctx.getParameter(0x8895);
      if (!twin || !twin.kwStale) return;
      kwgl.reload(twin);
    },
    // Bytes from one element of an attribute to the next with stride 0.
    elementSize(size, type) {
      switch (type) {
        case 0x1400: case 0x1401: return size; // BYTE, UNSIGNED_BYTE
        case 0x1402: case 0x1403: case 0x140B: return 2 * size; // SHORT, UNSIGNED_SHORT, HALF_FLOAT
        case 0x8D9F: case 0x8368: return 4; // INT_2_10_10_10_REV, UNSIGNED_INT_2_10_10_10_REV
        default: return 4 * size; // INT, UNSIGNED_INT, FLOAT, FIXED
      }
    },
    // Run DRAW with the enabled array attributes moved BASEVERTEX elements
    // on (BASEINSTANCE for instanced ones), as a base-vertex draw reads them.
    shifted(basevertex, baseinstance, draw) {
      const gl = GLctx;
      const n = (kwgl.maxAttribs ??= gl.getParameter(0x8869 /* MAX_VERTEX_ATTRIBS */));
      const moved = [];
      const bound = gl.getParameter(0x8894 /* ARRAY_BUFFER_BINDING */);
      for (let i = 0; i < n; i++) {
        if (!gl.getVertexAttrib(i, 0x8622 /* VERTEX_ATTRIB_ARRAY_ENABLED */)) continue;
        const by = gl.getVertexAttrib(i, 0x88FE /* VERTEX_ATTRIB_ARRAY_DIVISOR */) ? baseinstance : basevertex;
        if (!by) continue;
        const buf = gl.getVertexAttrib(i, 0x889F /* VERTEX_ATTRIB_ARRAY_BUFFER_BINDING */);
        if (!buf) continue;
        const a = {
          i, buf,
          size: gl.getVertexAttrib(i, 0x8623 /* SIZE */),
          type: gl.getVertexAttrib(i, 0x8625 /* TYPE */),
          norm: gl.getVertexAttrib(i, 0x886A /* NORMALIZED */),
          integer: gl.getVertexAttrib(i, 0x88FD /* INTEGER */),
          stride: gl.getVertexAttrib(i, 0x8624 /* STRIDE */),
          offset: gl.getVertexAttribOffset(i, 0x8645 /* POINTER */),
        };
        const offset = a.offset + by * (a.stride || kwgl.elementSize(a.size, a.type));
        if (offset < 0) {
          kwgl.once('a base vertex draw would read before its vertex buffer: drawn without the base');
          continue;
        }
        moved.push(a);
        kwgl.point(a, offset);
      }
      draw();
      for (const a of moved) kwgl.point(a, a.offset);
      if (moved.length) gl.bindBuffer(0x8892 /* ARRAY_BUFFER */, bound);
    },
    point(a, offset) {
      const gl = GLctx;
      gl.bindBuffer(0x8892, a.buf);
      if (a.integer) gl.vertexAttribIPointer(a.i, a.size, a.type, a.stride, offset);
      else gl.vertexAttribPointer(a.i, a.size, a.type, a.norm, a.stride, offset);
    },
    drawElements(mode, count, type, indices, instances, basevertex, baseinstance) {
      kwgl.syncElements();
      const x = kwgl.ext('WEBGL_draw_instanced_base_vertex_base_instance');
      if (x) {
        x.drawElementsInstancedBaseVertexBaseInstanceWEBGL(mode, count, type, indices, instances, basevertex, baseinstance);
        return;
      }
      kwgl.shifted(basevertex, baseinstance, () => GLctx.drawElementsInstanced(mode, count, type, indices, instances));
    },
    // After the GPU wrote to BUF (a WebGLBuffer of vrend's): its twin is stale.
    written(buf) {
      if (buf && buf.name) kwgl.setStale(kwgl.twins[buf.name], true);
    },
  },

  // --- buffer types ---

  kw_glGetString__deps: ['$kwgl', 'glGetString', '$stringToNewUTF8'],
  kw_glGetString: (name) => {
    if (name === 0x1F01) { // GL_RENDERER
      if (kwgl.renderer === undefined) {
        const info = kwgl.ext('WEBGL_debug_renderer_info');
        const s = info && GLctx.getParameter(info.UNMASKED_RENDERER_WEBGL);
        kwgl.renderer = s ? stringToNewUTF8(String(s)) : 0;
      }
      if (kwgl.renderer) return kwgl.renderer;
    }
    return _glGetString(name);
  },

  kw_glBindBuffer__deps: ['$kwgl', 'glBindBuffer'],
  kw_glBindBuffer: (target, buffer) => {
    if (target !== kwgl.ELEMENT || !buffer) return _glBindBuffer(target, buffer);
    let twin = kwgl.twins[buffer];
    if (!twin) {
      twin = kwgl.twins[buffer] = GLctx.createBuffer();
      twin.kwOrig = buffer;
      kwgl.ntwins++;
      kwgl.setStale(twin, true); // loaded from the buffer at its first draw
    }
    GLctx.bindBuffer(kwgl.ELEMENT, twin);
  },

  // On vrend's buffer (through a copy target when it is named by its
  // twin's binding), then on the twin, through a copy target, which takes
  // an element buffer too.
  kw_glBufferData__deps: ['$kwgl', 'glBufferData'],
  kw_glBufferData: (target, size, data, usage) => {
    if (!data) size = (size + 15) & ~15; // room for a padded uniform range (uniform sizes)
    const { buf, twin } = kwgl.reach(target);
    if (twin && target === kwgl.ELEMENT)
      kwgl.withCopy(kwgl.COPY_WRITE, buf, () => _glBufferData(kwgl.COPY_WRITE, size, data, usage));
    else _glBufferData(target, size, data, usage);
    if (!twin) return;
    kwgl.withCopy(kwgl.COPY_WRITE, twin, () => _glBufferData(kwgl.COPY_WRITE, size, data, usage));
    kwgl.setStale(twin, false);
  },

  kw_glBufferSubData__deps: ['$kwgl', 'glBufferSubData'],
  kw_glBufferSubData: (target, offset, size, data) => {
    const { buf, twin } = kwgl.reach(target);
    if (twin && target === kwgl.ELEMENT)
      kwgl.withCopy(kwgl.COPY_WRITE, buf, () => _glBufferSubData(kwgl.COPY_WRITE, offset, size, data));
    else _glBufferSubData(target, offset, size, data);
    if (twin && !twin.kwStale) kwgl.withCopy(kwgl.COPY_WRITE, twin, () => _glBufferSubData(kwgl.COPY_WRITE, offset, size, data));
  },

  kw_glGetBufferSubData__deps: ['$kwgl', 'glGetBufferSubData'],
  kw_glGetBufferSubData: (target, offset, size, data) => {
    if (target !== kwgl.ELEMENT) return _glGetBufferSubData(target, offset, size, data);
    const orig = kwgl.bound(target);
    kwgl.withCopy(kwgl.COPY_READ, orig, () => _glGetBufferSubData(kwgl.COPY_READ, offset, size, data));
  },

  kw_glCopyBufferSubData__deps: ['$kwgl', 'glCopyBufferSubData'],
  kw_glCopyBufferSubData: (readTarget, writeTarget, readOffset, writeOffset, size) => {
    const src = kwgl.bound(readTarget), dst = kwgl.bound(writeTarget);
    // through the copy targets, which take any buffer
    kwgl.withCopy(kwgl.COPY_READ, src, () => kwgl.withCopy(kwgl.COPY_WRITE, dst, () =>
      GLctx.copyBufferSubData(kwgl.COPY_READ, kwgl.COPY_WRITE, readOffset, writeOffset, size)));
    kwgl.written(dst);
  },

  kw_glDeleteBuffers__deps: ['$kwgl', 'glDeleteBuffers'],
  kw_glDeleteBuffers: (n, buffers) => {
    for (let i = 0; i < n; i++) {
      const id = {{{ makeGetValue('buffers', 'i*4', 'i32') }}};
      const twin = kwgl.twins[id];
      if (!twin) continue;
      kwgl.setStale(twin, false);
      delete kwgl.twins[id];
      kwgl.ntwins--;
      GLctx.deleteBuffer(twin);
    }
    _glDeleteBuffers(n, buffers);
  },

  // --- uniform sizes ---

  kw_glBindBufferRange__deps: ['glBindBufferRange'],
  kw_glBindBufferRange: (target, index, buffer, offset, size) => {
    if (target === 0x8A11 /* UNIFORM_BUFFER */) size = (size + 15) & ~15;
    _glBindBufferRange(target, index, buffer, offset, size);
  },

  // transform feedback wrote to its buffers
  $kwglFeedbackWritten__deps: ['$kwgl'],
  $kwglFeedbackWritten: () => {
    const n = (kwgl.maxFeedback ??= GLctx.getParameter(0x8C8B /* MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS */));
    for (let i = 0; i < n; i++) kwgl.written(GLctx.getIndexedParameter(0x8C8F /* TRANSFORM_FEEDBACK_BUFFER_BINDING */, i));
  },
  kw_glEndTransformFeedback__deps: ['$kwglFeedbackWritten', 'glEndTransformFeedback'],
  kw_glEndTransformFeedback: () => {
    _glEndTransformFeedback();
    kwglFeedbackWritten();
  },
  kw_glPauseTransformFeedback__deps: ['$kwglFeedbackWritten', 'glPauseTransformFeedback'],
  kw_glPauseTransformFeedback: () => {
    _glPauseTransformFeedback();
    kwglFeedbackWritten();
  },

  kw_glDrawElements__deps: ['$kwgl', 'glDrawElements'],
  kw_glDrawElements: (mode, count, type, indices) => {
    kwgl.syncElements();
    _glDrawElements(mode, count, type, indices);
  },
  kw_glDrawElementsInstanced__deps: ['$kwgl', 'glDrawElementsInstanced'],
  kw_glDrawElementsInstanced: (mode, count, type, indices, instances) => {
    kwgl.syncElements();
    _glDrawElementsInstanced(mode, count, type, indices, instances);
  },
  kw_glDrawRangeElements__deps: ['$kwgl', 'glDrawRangeElements'],
  kw_glDrawRangeElements: (mode, start, end, count, type, indices) => {
    kwgl.syncElements();
    _glDrawRangeElements(mode, start, end, count, type, indices);
  },

  // --- buffer maps ---

  glMapBufferRange__deps: ['$kwgl', 'malloc', 'kw_glGetBufferSubData'],
  glMapBufferRange: (target, offset, length, access) => {
    // READ 1, WRITE 2, INVALIDATE_RANGE 4, INVALIDATE_BUFFER 8, FLUSH_EXPLICIT 0x10
    if (kwgl.maps[target] || !(access & 3) || length < 0 || offset < 0) {
      GL.recordError(0x502 /* GL_INVALID_OPERATION */);
      return 0;
    }
    const ptr = _malloc(length || 1);
    if (!ptr) {
      GL.recordError(0x505 /* GL_OUT_OF_MEMORY */);
      return 0;
    }
    // What is not invalidated keeps its contents, also where a write map
    // does not write: read it unless all of it is invalidated.
    if (length && ((access & 1) || !(access & 0xC))) _kw_glGetBufferSubData(target, offset, length, ptr);
    kwgl.maps[target] = { ptr, offset, length, access };
    return ptr;
  },

  glFlushMappedBufferRange__deps: ['$kwgl', 'kw_glBufferSubData'],
  glFlushMappedBufferRange: (target, offset, length) => {
    const m = kwgl.maps[target];
    if (!m || !(m.access & 0x10) || offset < 0 || length < 0 || offset + length > m.length) {
      GL.recordError(0x502);
      return;
    }
    if (length) _kw_glBufferSubData(target, m.offset + offset, length, m.ptr + offset);
  },

  glUnmapBuffer__deps: ['$kwgl', 'free', 'kw_glBufferSubData'],
  glUnmapBuffer: (target) => {
    const m = kwgl.maps[target];
    if (!m) {
      GL.recordError(0x502);
      return 0;
    }
    delete kwgl.maps[target];
    if ((m.access & 2) && !(m.access & 0x10) && m.length) _kw_glBufferSubData(target, m.offset, m.length, m.ptr);
    _free(m.ptr);
    return 1;
  },

  // --- indexed blend ---

  glEnableIndexedEXT__deps: ['$kwgl'],
  glEnableIndexedEXT: (target, index) => kwgl.ext('OES_draw_buffers_indexed').enableiOES(target, index),
  glDisableIndexedEXT__deps: ['$kwgl'],
  glDisableIndexedEXT: (target, index) => kwgl.ext('OES_draw_buffers_indexed').disableiOES(target, index),
  glColorMaskIndexedEXT__deps: ['$kwgl'],
  glColorMaskIndexedEXT: (index, r, g, b, a) =>
    kwgl.ext('OES_draw_buffers_indexed').colorMaskiOES(index, !!r, !!g, !!b, !!a),
  glBlendFuncSeparateiARB__deps: ['$kwgl'],
  glBlendFuncSeparateiARB: (buf, srcRGB, dstRGB, srcAlpha, dstAlpha) =>
    kwgl.ext('OES_draw_buffers_indexed').blendFuncSeparateiOES(buf, srcRGB, dstRGB, srcAlpha, dstAlpha),
  glBlendEquationSeparateiARB__deps: ['$kwgl'],
  glBlendEquationSeparateiARB: (buf, modeRGB, modeAlpha) =>
    kwgl.ext('OES_draw_buffers_indexed').blendEquationSeparateiOES(buf, modeRGB, modeAlpha),

  // --- base vertex and base instance ---

  glDrawElementsBaseVertex__deps: ['$kwgl'],
  glDrawElementsBaseVertex: (mode, count, type, indices, basevertex) =>
    kwgl.drawElements(mode, count, type, indices, 1, basevertex, 0),
  // The range names indices before the base is added, which WebGL's
  // drawRangeElements cannot express: drawn without it.
  glDrawRangeElementsBaseVertex__deps: ['$kwgl'],
  glDrawRangeElementsBaseVertex: (mode, start, end, count, type, indices, basevertex) =>
    kwgl.drawElements(mode, count, type, indices, 1, basevertex, 0),
  glDrawElementsInstancedBaseVertex__deps: ['$kwgl'],
  glDrawElementsInstancedBaseVertex: (mode, count, type, indices, instances, basevertex) =>
    kwgl.drawElements(mode, count, type, indices, instances, basevertex, 0),
  glDrawElementsInstancedBaseVertexBaseInstance__deps: ['$kwgl'],
  glDrawElementsInstancedBaseVertexBaseInstance: (mode, count, type, indices, instances, basevertex, baseinstance) =>
    kwgl.drawElements(mode, count, type, indices, instances, basevertex, baseinstance),
  glDrawElementsInstancedBaseInstance__deps: ['$kwgl'],
  glDrawElementsInstancedBaseInstance: (mode, count, type, indices, instances, baseinstance) =>
    kwgl.drawElements(mode, count, type, indices, instances, 0, baseinstance),
  glDrawArraysInstancedBaseInstance__deps: ['$kwgl'],
  glDrawArraysInstancedBaseInstance: (mode, first, count, instances, baseinstance) => {
    const x = kwgl.ext('WEBGL_draw_instanced_base_vertex_base_instance');
    if (x) x.drawArraysInstancedBaseInstanceWEBGL(mode, first, count, instances, baseinstance);
    else kwgl.shifted(0, baseinstance, () => GLctx.drawArraysInstanced(mode, first, count, instances));
  },

  // --- framebuffers ---

  // a layer of a 3D texture (GL_OES_texture_3D, desktop GL 3.0)
  glFramebufferTexture3DOES: (target, attachment, textarget, texture, level, zoffset) =>
    GLctx.framebufferTextureLayer(target, attachment, GL.textures[texture], level, zoffset),
  glFramebufferTexture3D: 'glFramebufferTexture3DOES',

  // --- queries ---

  glGetQueryObjectiv: 'glGetQueryObjectuiv',
});
