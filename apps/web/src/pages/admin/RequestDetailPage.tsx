import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { RequestDetailPage as RequestDetail } from '../requests/RequestDetailPage';
import { requestDetailQueryOptions } from '../../features/request-history/api';
import { SettlementAction } from '../../features/request-history/SettlementAction';
import { useSession } from '../../features/session/useSession';

export default function RequestDetailPage() {
  const { id = '' } = useParams();
  const { client, user } = useSession();
  const query = useQuery(requestDetailQueryOptions({ client, userId: user!.id, scope: 'admin' }, id));
  return <><RequestDetail />{query.data && <SettlementAction request={query.data} />}</>;
}
