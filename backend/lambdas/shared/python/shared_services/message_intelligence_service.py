# Community edition stub — message intelligence is available in WarmReach Pro.
from shared_services.base_service import BaseService


class MessageIntelligenceService(BaseService):
    def compute_messaging_stats(self, edges):
        return {
            'totalConnections': 0,
            'totalOutbound': 0,
            'totalInbound': 0,
            'responseRate': 0.0,
            'avgResponseTimeHours': None,
            'avgMessageLength': 0.0,
            'mostActiveConnections': 0,
            'conversationDepth': 0.0,
        }

    def compute_per_connection_stats(self, edge_item):
        return {
            'outboundCount': 0,
            'inboundCount': 0,
            'responseRate': 0.0,
            'avgResponseTimeHours': None,
            'avgOutboundLength': 0.0,
            'lastMessageAt': None,
            'conversationTurns': 0,
        }
