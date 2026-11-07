import type {StructuredRoleEnvelopeV1} from "./roleContractV1.js";
export type ChatMaterial = StructuredRoleEnvelopeV1["artifacts"][number];
function unique(materials:ChatMaterial[]):ChatMaterial[] {
  const seen=new Set<string>();
  return materials.filter(material=>{const ref=material.ref.trim();if(seen.has(ref))return false;seen.add(ref);return true;});
}
/** Presentation cleanup only: task submission/validation still retain their evidence. */
export function compactChatReportMaterials(
  source:StructuredRoleEnvelopeV1, prepared:ChatMaterial[]=[],
): {envelope:StructuredRoleEnvelopeV1;overflow:ChatMaterial[]} {
  const index=source.output.findIndex(block=>block.type==="report" && block.report_kind==="final");
  if(index<0){
    const all=unique([...source.artifacts,...prepared]);
    return {envelope:{...source,artifacts:all.slice(0,8)},overflow:all.slice(8)};
  }
  const report=source.output[index];
  const sections=report.sections as Record<string,unknown>;
  const materials=sections.materials as ChatMaterial[];
  const all=unique([...materials,...source.artifacts,...prepared]);
  const output=[...source.output];
  output[index]={...report,sections:{...sections,materials:all.slice(0,8)}};
  // Respect the existing contract limits and retain genuinely distinct overflow.
  return {envelope:{...source,output,artifacts:all.slice(8,16)},overflow:all.slice(16)};
}
