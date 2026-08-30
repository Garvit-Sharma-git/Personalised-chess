/**
 * Express 4 does not catch rejections from async route handlers, so an
 * unexpected failure inside one becomes an unhandled rejection that takes the
 * whole process down. Wrapping funnels them into the normal error middleware.
 */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
