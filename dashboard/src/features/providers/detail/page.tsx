/** Provider detail page — thin owner. @returns page element */
import { useParams } from "react-router-dom";

export function ProviderDetailPage() {
  const { id } = useParams();
  return <div data-testid="provider-detail">{id}</div>;
}
