/** @type {import('next').NextConfig} */
const nextConfig = {
  // @alltix/db and @alltix/shared are workspace packages published as plain
  // .ts-compiled-to-.js -- transpile them through Next's build instead of
  // requiring them to ship their own Next-compatible build.
  transpilePackages: ["@alltix/db", "@alltix/shared"],
};

export default nextConfig;
