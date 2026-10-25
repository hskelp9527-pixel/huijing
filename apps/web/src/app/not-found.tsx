import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="empty-state" style={{ minHeight: "100vh" }}>
      <h3>这个页面不存在</h3>
      <p>链接可能已失效。</p>
      <Link className="btn btn-primary" href="/">
        回到首页
      </Link>
    </main>
  );
}
