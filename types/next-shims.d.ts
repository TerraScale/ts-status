declare module "next" {
  export type { Metadata, Viewport } from "vinext/shims/metadata";
}

declare module "next/link" {
  export { default } from "vinext/shims/link";
  export * from "vinext/shims/link";
}

declare module "next/navigation" {
  export * from "vinext/shims/navigation";
}

declare module "next/headers" {
  export * from "vinext/shims/headers";
}

declare module "next/server" {
  export * from "vinext/shims/server";
}
