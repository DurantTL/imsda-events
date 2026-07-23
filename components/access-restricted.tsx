import { LockKeyhole } from "lucide-react";

export function AccessRestricted({ title, detail }: { title: string; detail: string }) {
  return <section className="page-stack"><div className="forbidden-state panel"><span><LockKeyhole size={26} /></span><p className="eyebrow">Permission required</p><h2>{title}</h2><p>{detail}</p></div></section>;
}
