/** @type {import('next').NextConfig} */
const nextConfig = {
  // @alltix/db, @alltix/shared, and @alltix/channel-connectors are workspace
  // packages published as plain .ts-compiled-to-.js -- transpile them
  // through Next's build instead of requiring them to ship their own
  // Next-compatible build.
  transpilePackages: ["@alltix/db", "@alltix/shared", "@alltix/channel-connectors"],
};

export default nextConfig;
