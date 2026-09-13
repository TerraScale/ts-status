import "./styles.css";

export const metadata = {
  title: "TerraScale Status",
  description: "Live operational status for TerraScale services",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
